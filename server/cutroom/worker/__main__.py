"""Remote worker — the microservice/VM story.

Runs on any box (typically next to a ComfyUI install), claims jobs from the
server by pool over HTTP, executes the SAME handlers as in-process workers,
and reports back. Media flows through shared storage: point CUTROOM_DATA at
the same volume (NFS/SMB/S3-mount) the server uses.

    python -m cutroom.worker --server http://host:8770 --token T \
        --pools backend:my-vm-comfy,cpu

On the server, mark the backend remote so in-process workers leave its jobs
alone:  options: {"remote": true}
"""
from __future__ import annotations

import argparse
import asyncio
import socket
import time
import traceback

import httpx


class RemoteCtx:
    def __init__(self, client: httpx.AsyncClient, job_id: str):
        self.client = client
        self.job_id = job_id
        self._buf: list[str] = []
        from ..config import get_settings
        self.settings = get_settings()

    def log(self, line: str) -> None:
        stamp = time.strftime("%H:%M:%S")
        print(f"[{self.job_id}] {line}", flush=True)
        self._buf.append(f"[{stamp}] {line}")

    async def flush(self) -> None:
        if not self._buf:
            return
        lines, self._buf = self._buf, []
        try:
            await self.client.post(f"/api/workers/jobs/{self.job_id}/log",
                                   json={"lines": lines})
        except Exception:
            pass

    def submit(self, *a, **k):
        raise RuntimeError("remote workers cannot submit follow-up jobs "
                           "directly; use the job's chain field")


async def run_one(client: httpx.AsyncClient, job: dict) -> None:
    from ..jobs import handlers
    ctx = RemoteCtx(client, job["id"])
    handler = handlers.HANDLERS.get(job["type"])
    status, result, error = "done", {}, None
    try:
        if handler is None:
            raise RuntimeError(f"no handler for {job['type']}")
        result = await handler(ctx, dict(job.get("payload") or {})) or {}
    except Exception as e:
        status, error = "failed", f"{type(e).__name__}: {e}"
        ctx.log(traceback.format_exc())
    await ctx.flush()
    await client.post(f"/api/workers/jobs/{job['id']}/complete",
                      json={"status": status, "result": result,
                            "error": error})
    print(f"[{job['id']}] {status}", flush=True)


async def main_loop(server: str, token: str, pools: list[str],
                    name: str) -> None:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    async with httpx.AsyncClient(base_url=server, headers=headers,
                                 timeout=60) as client:
        print(f"cutroom worker '{name}' polling {server} pools={pools}")
        while True:
            try:
                r = await client.post("/api/workers/claim",
                                      json={"pools": pools, "name": name})
                r.raise_for_status()
                job = r.json().get("job")
            except Exception as e:
                print(f"claim failed: {e}; retrying in 10s", flush=True)
                await asyncio.sleep(10)
                continue
            if not job:
                await asyncio.sleep(3)
                continue
            print(f"claimed {job['id']}: {job['title']}", flush=True)
            await run_one(client, job)


def cli() -> None:
    ap = argparse.ArgumentParser(description="Cutroom remote worker")
    ap.add_argument("--server", required=True)
    ap.add_argument("--token", default="")
    ap.add_argument("--pools", required=True,
                    help="comma-separated, e.g. backend:vm-comfy,cpu")
    ap.add_argument("--name", default=socket.gethostname())
    args = ap.parse_args()
    asyncio.run(main_loop(args.server.rstrip("/"), args.token,
                          [p.strip() for p in args.pools.split(",")],
                          args.name))


if __name__ == "__main__":
    cli()
