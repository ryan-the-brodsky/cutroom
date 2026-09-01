"""DB-backed job queue with per-pool concurrency.

Pools replace the old single serial GPU queue:
  backend:<id>  — GPU backends run strictly serial by default (the memory
                  discipline, now scoped per backend instead of per machine)
  cpu           — comps, freezes, panels, assembly (parallel, small)
  api           — hosted API calls

In-process pool workers run by default (single-binary deploy). Remote workers
claim jobs from the same table over HTTP (see api/workers.py) for pools whose
backend is marked options.remote=true — the microservice/VM story.
"""
from __future__ import annotations

import asyncio
import time
import traceback
from pathlib import Path

from sqlalchemy import select

from ..config import get_settings
from ..db import session_scope
from ..models import Backend, Job, Project
from ..adapters.registry import ADAPTER_TYPES


class JobContext:
    def __init__(self, queue: "JobQueue", job_id: str, log_file):
        self.queue = queue
        self.job_id = job_id
        self._log_file = log_file
        self.settings = get_settings()

    def log(self, line: str) -> None:
        stamp = time.strftime("%H:%M:%S")
        self._log_file.write(f"[{stamp}] {line}\n")
        self._log_file.flush()

    def submit(self, type: str, payload: dict, project_id: str | None,
               pool: str, title: str, chain: dict | None = None) -> str:
        with session_scope() as s:
            job = submit_job(s, type, payload, project_id, pool, title, chain)
            return job.id


class JobQueue:
    def __init__(self):
        self.tasks: dict[str, asyncio.Task] = {}
        self.dispatcher: asyncio.Task | None = None
        self.stopping = False

    # ------------------------------------------------------------ dispatch
    def pool_concurrency(self, pool: str, session) -> int:
        settings = get_settings()
        if pool == "cpu":
            return settings.cpu_pool_size
        if pool.startswith("backend:"):
            b = session.get(Backend, pool.split(":", 1)[1])
            if b:
                kind = getattr(ADAPTER_TYPES.get(b.type), "kind", "api")
                default = 1 if kind == "gpu" else settings.api_pool_size
                return max(1, int((b.options or {}).get("concurrency", default)))
            return 1
        return settings.api_pool_size

    def _pool_is_remote(self, pool: str, session) -> bool:
        if pool.startswith("backend:"):
            b = session.get(Backend, pool.split(":", 1)[1])
            return bool(b and (b.options or {}).get("remote"))
        return False

    async def dispatch_loop(self) -> None:
        while not self.stopping:
            try:
                self._dispatch_once()
            except Exception:
                traceback.print_exc()
            await asyncio.sleep(1.0)

    def _dispatch_once(self) -> None:
        settings = get_settings()
        global_pause = (settings.data_dir / "PAUSED").exists()
        with session_scope() as s:
            running = s.execute(select(Job).where(Job.status == "running",
                                                  Job.worker == "local")).scalars().all()
            running_by_pool: dict[str, int] = {}
            for j in running:
                running_by_pool[j.pool] = running_by_pool.get(j.pool, 0) + 1
                # reap zombie rows whose task vanished (crash recovery)
                if j.id not in self.tasks:
                    j.status = "failed"
                    j.error = "worker task lost (server restart?)"
                    j.finished_at = time.time()
                    running_by_pool[j.pool] -= 1
            queued = s.execute(select(Job).where(Job.status == "queued")
                               .order_by(Job.created_at)).scalars().all()
            paused_projects = {p.id for p in s.query(Project).filter(
                Project.paused.is_(True))}
            for job in queued:
                if global_pause and job.pool != "cpu":
                    continue
                if job.project_id in paused_projects and job.pool != "cpu":
                    continue
                if self._pool_is_remote(job.pool, s):
                    continue  # remote workers claim these over HTTP
                used = running_by_pool.get(job.pool, 0)
                if used >= self.pool_concurrency(job.pool, s):
                    continue
                job.status = "running"
                job.started_at = time.time()
                job.worker = "local"
                running_by_pool[job.pool] = used + 1
                self.tasks[job.id] = asyncio.get_event_loop().create_task(
                    self._run(job.id))

    # ------------------------------------------------------------ execution
    async def _run(self, job_id: str) -> None:
        from . import handlers
        settings = get_settings()
        with session_scope() as s:
            job = s.get(Job, job_id)
            jtype, log_rel = job.type, job.log_path
        log_path = settings.logs_dir / (log_rel or f"job-{job_id}.log")
        log_path.parent.mkdir(parents=True, exist_ok=True)
        status, error, result, chain_spec = "done", None, {}, None
        with open(log_path, "a") as lf:
            ctx = JobContext(self, job_id, lf)
            try:
                handler = handlers.HANDLERS.get(jtype)
                if handler is None:
                    raise RuntimeError(f"no handler for job type {jtype}")
                with session_scope() as s:
                    payload = dict(s.get(Job, job_id).payload or {})
                result = await handler(ctx, payload) or {}
            except asyncio.CancelledError:
                status, error = "cancelled", "cancelled"
                ctx.log("CANCELLED")
            except Exception as e:
                status, error = "failed", f"{type(e).__name__}: {e}"
                ctx.log("FAILED: " + error)
                ctx.log(traceback.format_exc())
        with session_scope() as s:
            job = s.get(Job, job_id)
            job.status = status
            job.error = error
            job.result = result
            job.finished_at = time.time()
            if status == "done" and job.chain:
                chain_spec = dict(job.chain)
        self.tasks.pop(job_id, None)
        if chain_spec:
            with session_scope() as s:
                submit_job(s, chain_spec["type"], chain_spec.get("payload", {}),
                           chain_spec.get("project_id"),
                           chain_spec.get("pool", "cpu"),
                           chain_spec.get("title", chain_spec["type"]),
                           chain_spec.get("chain"))

    def cancel(self, job_id: str) -> str:
        with session_scope() as s:
            job = s.get(Job, job_id)
            if not job:
                return "missing"
            if job.status == "queued":
                job.status = "cancelled"
                job.finished_at = time.time()
                return "cancelled"
        task = self.tasks.get(job_id)
        if task:
            task.cancel()
            return "cancelling"
        return "not-running"

    def start(self) -> None:
        if self.dispatcher is None or self.dispatcher.done():
            self.stopping = False
            self.dispatcher = asyncio.get_event_loop().create_task(
                self.dispatch_loop())

    async def stop(self) -> None:
        self.stopping = True
        if self.dispatcher:
            self.dispatcher.cancel()
        for t in list(self.tasks.values()):
            t.cancel()


_queue: JobQueue | None = None


def get_queue() -> JobQueue:
    global _queue
    if _queue is None:
        _queue = JobQueue()
    return _queue


def submit_job(session, type: str, payload: dict, project_id: str | None,
               pool: str, title: str, chain: dict | None = None) -> Job:
    from ..models import new_id
    job = Job(id=new_id(), project_id=project_id, type=type, pool=pool,
              title=title[:290], payload=payload, chain=chain,
              log_path=None)
    job.log_path = f"job-{job.id}.log"
    session.add(job)
    session.flush()
    return job


def job_log_path(job: Job) -> Path:
    return get_settings().logs_dir / (job.log_path or f"job-{job.id}.log")
