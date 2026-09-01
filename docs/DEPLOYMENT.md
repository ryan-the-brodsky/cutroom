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

---

## Hosted demo (Railway)

The judge-facing instance for the WebMCP Challenge.

| | |
|---|---|
| Railway project | `cutroom-demo` (`03953bf7-7b2a-420c-b2d9-21c970adcfb0`) |
| Service | `cutroom` (`432042c8-5b3b-4ac4-9bdc-8c60a5ed3e97`) |
| Environment | `production` (`aa83e186-a468-4901-aa8f-f1093013caf8`), region `sfo` |
| Public URL | <https://cutroom-production-0f3c.up.railway.app> |
| Volume | `cutroom-data` mounted at `/data` |
| Source | the GHCR image `ghcr.io/ryan-the-brodsky/cutroom:latest` |

### Why the image, not a source build

Railway's build service is **unavailable on this workspace**: every source
build — GitHub source *and* `railway up`, with `RAILWAY_DOCKERFILE_PATH` set
and with a root `railway.json` pinning `builder: DOCKERFILE` — fails in about
three seconds at stage `BUILD_IMAGE` with no output beyond
`scheduling build on Metal builder "builder-…"`.

What that was narrowed down to (2026-09-01):

- Same failure on two different builder instances (`builder-cpzdgy`,
  `builder-efievd`) and on a second, freshly created probe service with no
  volume attached — so it is not one bad builder and not this service.
- A plain `nginx:alpine` image service in the same project and region (`sfo`)
  deploys `SUCCESS` — the deploy path and the region are healthy.
- `status.railway.com` reported builds fully operational at the time — not a
  platform incident.

That leaves a **workspace-level plan / quota / payment limit** on
"ryan-the-brodsky's Projects". Check Railway billing to restore source builds.

So [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) builds
`deploy/Dockerfile` in GitHub Actions, pushes it to
`ghcr.io/ryan-the-brodsky/cutroom:latest`, and Railway pulls that image.
`railway.json` and `.railwayignore` are kept so a source build works again the
moment Railway fixes the builder — to switch back, attach the repo as the
source and drop the image.

**Ship a change**: push to `main` → CI builds and pushes the image → redeploy
the Railway service to pick up the new `:latest`.

```bash
# from the platform dir, once per machine
railway link -p 03953bf7-7b2a-420c-b2d9-21c970adcfb0 -e production -s cutroom

git push origin main                 # CI builds ghcr.io/.../cutroom:latest
gh run watch --repo ryan-the-brodsky/cutroom
railway redeploy --service cutroom -y
curl -sf https://cutroom-production-0f3c.up.railway.app/api/health
```

The GHCR package must be **public** for Railway to pull it without registry
credentials (the repo itself may stay private):

```bash
gh api -X PATCH /user/packages/container/cutroom -f visibility=public
# or: github.com/users/ryan-the-brodsky/packages/container/cutroom/settings
```

### Variables (names only — values live in Railway and `~/.claude/.env`)

Bind and demo policy:

| name | value | why |
|---|---|---|
| `CUTROOM_HOST` | `0.0.0.0` | bind for the container |
| `CUTROOM_PORT` | `8770` | matches the generated domain's target port |
| `CUTROOM_DATA` | `/data` | the mounted volume |
| `CUTROOM_DEMO` | `1` | demo mode (Addendum A role split) |
| `CUTROOM_DEMO_BUDGET_USD` | `10` | rolling 24 h paid-lane spend cap |
| `CUTROOM_RUN_WORKERS` | `1` | in-process workers |
| `CUTROOM_CPU_POOL_SIZE` | `2` | parallel CPU jobs |
| `CUTROOM_ALLOW_CLAUDE_CLI` | `0` | no shell on a public host |
| `RAILWAY_DOCKERFILE_PATH` | `deploy/Dockerfile` | only used if source builds are restored |

Secrets (**never** commit these; generated with `openssl rand -hex`):

- `CUTROOM_AUTH_TOKEN` — judge/viewer token, 20 chars. Goes in the Devpost
  testing-instructions field and in the one-click link as `?token=…`.
- `CUTROOM_ADMIN_TOKEN` — Ryan only, 32 chars. Required to edit backends,
  lanes, keys, import, delete or pause.
- `CUTROOM_WORKER_TOKEN` — remote worker job claims.

Provider keys (Addendum A; anything unset falls back to the `mock` lane):

- `ELEVEN_LABS_API_KEY` — **set**.
- `FAL_KEY` — **not set** (motion lane). The value exists locally in the
  `fal` row of `~/.cutroom/cutroom.db`; copy it over by hand.
- `OPENROUTER_API_KEY` — **not set** (direction + still lanes). No local copy
  exists; mint one at <https://openrouter.ai/keys>.

Lane defaults (`<backend>:<model>` — models are blank placeholders until
workstream B pins the exact ids):

`CUTROOM_LANE_DIRECTION=openrouter:` · `CUTROOM_LANE_STILL=openrouter-image:` ·
`CUTROOM_LANE_I2I=fal:` · `CUTROOM_LANE_MOTION=fal:` ·
`CUTROOM_LANE_VO=elevenlabs:`

Demo data (set once workstream B's `cutroom demo-bundle` and boot importer
land): `CUTROOM_DEMO_BUNDLE` = the GitHub Release asset API URL
`https://api.github.com/repos/ryan-the-brodsky/cutroom/releases/assets/<id>`,
`CUTROOM_DEMO_BUNDLE_TOKEN` = a token with `contents:read` on the repo (only
needed while the repo is private).

```bash
railway variables --set 'NAME=value'          # add or change one
railway variables                             # list (values shown — do not paste)
```

### Rotating tokens

```bash
NEW=$(openssl rand -hex 16)
railway variables --set "CUTROOM_ADMIN_TOKEN=$NEW"   # redeploys automatically
```

Then update the matching line in `~/.claude/.env`
(`CUTROOM_DEMO_JUDGE_TOKEN` / `CUTROOM_DEMO_ADMIN_TOKEN`, chmod 600) and, if
the judge token changed, the Devpost testing instructions and the `?token=`
link. Rotate every token if any one of them is ever pasted into a chat, a
commit, a screenshot or the demo video.

### Resetting the demo volume

The volume holds the DB and all project media, so wiping it returns the
instance to a clean boot — and, once `CUTROOM_DEMO_BUNDLE` is set, the boot
importer re-imports `next-year` from the bundle automatically.

- **Data only, keep the volume**: shell in and clear it, then restart —
  `railway ssh --service cutroom` then `rm -rf /data/* /data/.??*`, then
  `railway redeploy --service cutroom -y`.
- **Nuke and recreate**: delete the `cutroom-data` volume in the Railway
  dashboard, create a new one mounted at `/data`, redeploy. Railway volumes
  start at 5 GB; grow it in the dashboard (Service → Volume → Size) if the
  bundle plus generated takes get close. The bundle is ~300 MB.

Before judging opens, reset once so judges land on a clean film, and confirm
`GET /api/projects` lists `next-year` with ~97 shots.

### Flipping the repo public

Required for submission — judges must see the source and the MIT license in
the About box. Ryan's explicit word only:

```bash
gh repo edit ryan-the-brodsky/cutroom \
  --visibility public --accept-visibility-change-consequences
gh repo view ryan-the-brodsky/cutroom --json isPrivate,licenseInfo
```

Check first that nothing private has crept in: the film's script, bible and
prompts live in the separate private `game7` repo and must stay there, and no
`.env`, token or provider key may be in the history
(`git log -p | grep -iE 'api[_-]?key|token'`). Once public, drop
`CUTROOM_DEMO_BUNDLE_TOKEN` — release assets on a public repo need no auth.
