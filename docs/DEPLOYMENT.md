# Deploying Cutroom

## Topology

```
              users (browser, token auth)
                       │
             ┌─────────▼──────────┐
             │  cutroom server    │  API + SPA + in-process workers
             │  (docker / VM)     │  SQLite or Postgres
             └───┬──────────┬─────┘
     push model  │          │  pull model
 ┌───────────────▼──┐   ┌───▼──────────────────────┐
 │ ComfyUI hosts    │   │ cutroom-worker on GPU VM │
 │ (server drives   │   │ (claims jobs over HTTP,  │
 │  them over HTTP) │   │  shares project storage) │
 └──────────────────┘   └──────────────────────────┘
        hosted APIs: fal · replicate · elevenlabs · anthropic (keys in DB)
```

Two ways to attach GPU capacity:

1. **Push (simplest)** — the server calls the ComfyUI HTTP API directly.
   Register a backend with the box's URL. Works for any box the server can
   reach; media never needs shared storage (upload/download over HTTP).
2. **Pull (workers)** — mark the backend `options.remote: true` and run
   `cutroom-worker --pools backend:<id>` on the GPU machine, pointed at the
   server with `CUTROOM_WORKER_TOKEN`. The worker executes the full job
   handler (crop → generate → composite) locally, so it needs the project
   storage mounted at the same `CUTROOM_DATA`. Use when the GPU box can
   reach the server but not vice-versa (NAT), or to co-locate CPU compositing
   with generation.

## Docker

```bash
cd platform
cp deploy/env.example deploy/.env    # set tokens/keys
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up --build
# optional extra CPU worker:
docker compose -f deploy/docker-compose.yml --profile worker up -d
```

The image builds the SPA, installs the server with ffmpeg, and stores
everything under the `cutroom-data` volume (`/data`).

## Bare metal / this Mac

```bash
cd platform && ./dev.sh build && ./dev.sh server
```

Data lives in `~/.cutroom` (override with `CUTROOM_DATA`). The server binds
`127.0.0.1:8770` by default; set `CUTROOM_HOST=0.0.0.0` +
`CUTROOM_AUTH_TOKEN` to expose it.

## Configuration reference

| env | default | meaning |
|---|---|---|
| `CUTROOM_DATA` | `~/.cutroom` | project stores, DB, logs |
| `CUTROOM_DATABASE_URL` | sqlite in data dir | any SQLAlchemy URL (Postgres for multi-node) |
| `CUTROOM_AUTH_TOKEN` | *(off)* | bearer token for API+SPA; media accepts `?token=` |
| `CUTROOM_WORKER_TOKEN` | *(auth token)* | remote worker claims |
| `CUTROOM_HOST` / `CUTROOM_PORT` | `127.0.0.1` / `8770` | bind |
| `CUTROOM_RUN_WORKERS` | `1` | in-process pool workers (0 = API-only node) |
| `CUTROOM_CPU_POOL_SIZE` | `2` | parallel CPU jobs (comps/freezes/assembly) |
| `CUTROOM_ALLOW_CLAUDE_CLI` | `0` | enable the `claude -p` direction provider |
| `ANTHROPIC_API_KEY` | — | seeds the hosted-director backend at first boot |
| `ELEVEN_LABS_API_KEY` | — | seeds the voice backend at first boot |

## Multi-node notes

- SQLite is fine for one server node (WAL mode). Use Postgres
  (`pip install "cutroom[postgres]"`, set `CUTROOM_DATABASE_URL`) when API
  replicas or many workers share the DB.
- Project storage is a directory tree per project; for multi-node, mount it
  shared (NFS/EFS) or implement the `Storage` seam for S3 (single interface
  in `cutroom/storage.py`).
- Global pause: `POST /api/system/pause` (creates `CUTROOM_DATA/PAUSED` —
  the old MOTION_PAUSED sentinel, promoted to an API). Per-project pause:
  `POST /api/projects/<p>/pause`.

## Security posture

- Keys live in the DB, masked on read, never logged.
- Media paths resolve through per-project jails (no traversal).
- Hosted direction = function tools only; no shell. `claude-cli` requires an
  explicit env opt-in and should stay off on shared hosts.
- Remote workers authenticate with the worker token; scope it separately
  from the user token.
