from __future__ import annotations

import asyncio
import json
import time

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import select

from ..db import session_scope
from ..jobs.queue import get_queue, job_log_path, submit_job
from ..models import Job
from .deps import require_worker

router = APIRouter()


def _job_dict(j: Job) -> dict:
    return {"id": j.id, "project": j.project_id, "type": j.type,
            "pool": j.pool, "title": j.title, "status": j.status,
            "created_at": j.created_at, "started_at": j.started_at,
            "finished_at": j.finished_at, "result": j.result,
            "error": j.error, "worker": j.worker}


@router.get("/jobs")
def list_jobs(project: str | None = None, status: str | None = None,
              limit: int = 60):
    with session_scope() as s:
        q = select(Job)
        if project:
            q = q.where(Job.project_id == project)
        if status:
            q = q.where(Job.status == status)
        rows = s.execute(q.order_by(Job.created_at.desc())
                         .limit(limit)).scalars()
        return [_job_dict(j) for j in rows]


@router.get("/jobs/{jid}")
def get_job(jid: str):
    with session_scope() as s:
        j = s.get(Job, jid)
        if not j:
            raise HTTPException(404, jid)
        return _job_dict(j)


@router.get("/jobs/{jid}/log")
def job_log(jid: str, tail: int = 80):
    with session_scope() as s:
        j = s.get(Job, jid)
        if not j:
            raise HTTPException(404, jid)
        path = job_log_path(j)
        status = j.status
    lines: list[str] = []
    if path.exists():
        lines = path.read_text(errors="replace").splitlines()[-tail:]
    return {"status": status, "lines": lines}


@router.post("/jobs/{jid}/cancel")
def cancel_job(jid: str):
    return {"status": get_queue().cancel(jid)}


@router.get("/jobs/{jid}/watch")
async def watch_job(jid: str):
    """SSE: stream log lines + status until the job finishes."""
    with session_scope() as s:
        j = s.get(Job, jid)
        if not j:
            raise HTTPException(404, jid)
        path = job_log_path(j)

    async def sse():
        sent = 0
        while True:
            with session_scope() as s2:
                j2 = s2.get(Job, jid)
                status = j2.status if j2 else "missing"
            if path.exists():
                lines = path.read_text(errors="replace").splitlines()
                for line in lines[sent:]:
                    yield f"data: {json.dumps({'kind': 'log', 'text': line})}\n\n"
                sent = len(lines)
            if status in ("done", "failed", "cancelled", "missing"):
                with session_scope() as s3:
                    j3 = s3.get(Job, jid)
                    payload = {"kind": "status", "status": status,
                               "result": (j3.result if j3 else None),
                               "error": (j3.error if j3 else None)}
                yield f"data: {json.dumps(payload)}\n\n"
                return
            yield f"data: {json.dumps({'kind': 'status', 'status': status})}\n\n"
            await asyncio.sleep(1.5)
    return StreamingResponse(sse(), media_type="text/event-stream")


# ---------------------------------------------------------- remote workers
# A worker on a GPU VM runs `python -m cutroom.worker --server URL --token T
# --pools backend:my-vm-comfy` and executes the same handlers against its
# local ComfyUI, streaming results back through these routes.

@router.post("/workers/claim", dependencies=[Depends(require_worker)])
async def worker_claim(req: Request):
    body = await req.json()
    pools = body.get("pools") or []
    name = body.get("name", "remote")
    if not pools:
        raise HTTPException(400, "need pools")
    with session_scope() as s:
        job = s.execute(select(Job).where(Job.status == "queued",
                                          Job.pool.in_(pools))
                        .order_by(Job.created_at).limit(1)).scalar_one_or_none()
        if not job:
            return {"job": None}
        running = s.execute(select(Job).where(
            Job.status == "running", Job.pool == job.pool)).scalars().all()
        if running:
            return {"job": None}
        job.status = "running"
        job.started_at = time.time()
        job.worker = name
        return {"job": {"id": job.id, "type": job.type, "pool": job.pool,
                        "payload": job.payload, "project": job.project_id,
                        "title": job.title}}


@router.post("/workers/jobs/{jid}/log", dependencies=[Depends(require_worker)])
async def worker_log(jid: str, req: Request):
    body = await req.json()
    with session_scope() as s:
        j = s.get(Job, jid)
        if not j:
            raise HTTPException(404, jid)
        path = job_log_path(j)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a") as f:
        for line in body.get("lines", []):
            f.write(line.rstrip("\n") + "\n")
    return {"ok": True}


@router.post("/workers/jobs/{jid}/complete",
             dependencies=[Depends(require_worker)])
async def worker_complete(jid: str, req: Request):
    body = await req.json()
    chain_spec = None
    with session_scope() as s:
        j = s.get(Job, jid)
        if not j:
            raise HTTPException(404, jid)
        j.status = body.get("status", "done")
        j.result = body.get("result", {})
        j.error = body.get("error")
        j.finished_at = time.time()
        if j.status == "done" and j.chain:
            chain_spec = dict(j.chain)
    if chain_spec:
        with session_scope() as s:
            submit_job(s, chain_spec["type"], chain_spec.get("payload", {}),
                       chain_spec.get("project_id"),
                       chain_spec.get("pool", "cpu"),
                       chain_spec.get("title", chain_spec["type"]))
    return {"ok": True}
