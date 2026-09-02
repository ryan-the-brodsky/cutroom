# Deploying Genga Studio

## Routes

The server is one origin with three kinds of path:

| Path | What it is |
|---|---|
| `/` | the public landing page (static-feeling; the SPA renders it) |
| `/app`, `/app/p/:pid/...` | the studio (Projects, Film Editor, Shot Editor, Jobs, Settings) |
| `/api/*` | the API; never touched by the SPA history fallback |

`web/src/routes.ts` holds the single `APP_BASE` constant every route builder uses.
Deep links minted before the move (`/p/…`, `/jobs`, `/settings`) redirect to their
`/app/...` equivalent with the query string intact, so a pasted `?token=` link still
works. The judge link is `https://gengastudio.com/app?token=<JUDGE_TOKEN>`, which skips the landing
page and opens the studio.

The landing page's stills live in `web/public/landing/` and are served as real files by
the static mount. "Watch the film" plays the newest assembled cut the instance actually
holds (it reads `/api/projects` then that project's newest `animatic` take), so nothing
video is committed to the repo. `?demo=<url>` overrides it, and a file dropped at
`web/public/landing/two-claudes.mp4` is used when the API path finds nothing.

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
| `CUTROOM_ENCODER_THREADS` | `4` | x264 threads for streaming renders (comps). Each thread holds a frame buffer, so this is the dial that keeps a memory-capped container alive; `0` means all cores |
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
- Global pause: `POST /api/system/pause` (creates `CUTROOM_DATA/PAUSED`, the
  pause sentinel, promoted to an API). Per-project pause:
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
| Public URL | <https://gengastudio.com> (fallback <https://cutroom-production-0f3c.up.railway.app>) |
| Volume | `cutroom-data` mounted at `/data` |
| Source | the GHCR image `ghcr.io/ryan-the-brodsky/cutroom-demo`, pinned to a `sha-<short>` tag |
| Status | live — `/` serves the landing page, `/app` the studio, `/api/health` 200, demo mode on |

### Custom domain

`gengastudio.com` is live on this service. DNS is on Cloudflare and every
record is **DNS-only** (grey cloud), not proxied.

| Type | Name | Value |
|---|---|---|
| CNAME | `gengastudio.com` | `nl382197.up.railway.app` |
| CNAME | `www` | `59r5ux05.up.railway.app` |
| TXT | `_railway-verify` | `railway-verify=5b8e4732bea75c291995b0648eb4f8e2c153c1079fda1f956e45d2691cbf0b8d` |

The Railway side was created with:

```bash
railway domain gengastudio.com --service cutroom --port 8770
railway domain www.gengastudio.com --service cutroom --port 8770
```

The Railway-provided `*.up.railway.app` URL stays valid as a fallback, so the
health checks and judge links pointing at it keep working. The Railway
**service** is still named `cutroom`. That is deliberate: it is an identifier,
not the product name, and renaming it would move the deployment.

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

That leaves a **workspace-level plan / quota / payment limit** on the Railway
workspace. Check Railway billing to restore source builds.

So [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) builds
`deploy/Dockerfile` in GitHub Actions and pushes it to the **public** package
`ghcr.io/ryan-the-brodsky/cutroom-demo` (note the `-demo` suffix: the image is
public even though it is built from this repo, so it is a separate package from
anything named after the repo alone). Railway pulls that image.
`railway.json` and `.railwayignore` are kept so a source build works again the
moment Railway fixes the builder.

### Ship a change

Two things make this less obvious than it looks, both learned the hard way:

1. **Deploy by pinned tag, not `:latest`.** Railway will not re-pull a tag it
   believes it already has, so `railway redeploy` on `:latest` silently
   redeploys the *old* image. CI tags every build `sha-<short>`; point the
   service at the new one — a distinct reference forces a real pull, and the
   running image is then unambiguous.
2. **Keep the GitHub source detached.** If a repo is attached as a source,
   every push to `main` auto-triggers a *source* build, which this workspace's
   dead builder fails in ~4 s — and `railway redeploy` then re-runs that failed
   source build instead of pulling the image. Attaching an image clears the
   repo; check with `get-service-config` that `source.branch` is `null`.

```bash
# from the platform dir, once per machine
railway link -p 03953bf7-7b2a-420c-b2d9-21c970adcfb0 -e production -s cutroom

git push origin main
gh run watch --repo ryan-the-brodsky/cutroom          # all three jobs green

SHA=$(git rev-parse --short HEAD)
railway service update -s cutroom --image "ghcr.io/ryan-the-brodsky/cutroom-demo:sha-$SHA"
# or the Railway MCP: connect-service-source --image ghcr.io/.../cutroom-demo:sha-$SHA

curl -sf https://cutroom-production-0f3c.up.railway.app/api/health   # {"ok":true}
curl -s -o /dev/null -w '%{http_code}\n' https://cutroom-production-0f3c.up.railway.app/   # 200
```

Verify **both** `/api/health` and `/` — health alone passes while the SPA is
missing, which is exactly the failure that shipped once (see below).

### Two bugs this image had, so they are not reintroduced

- **The SPA was silently absent.** `web/dist` was copied to
  `server/cutroom/static` *before* `pip install ./server`. setuptools only
  packages importable directories; `static/` has no `__init__.py` and nothing
  declares it as package data, so it never reached site-packages. `main.py`
  mounts the SPA only `if static.is_dir()`, so the route was never registered
  and every non-API path returned a JSON 404 while `/api/health` stayed green.
  The Dockerfile now copies the bundle into the *installed* package after the
  install and asserts `index.html` and `assets/` exist, so a regression fails
  the build instead of shipping a working API with no UI.
- **Healthchecks failed against a healthy server.** Railway probes the port it
  injects, not `EXPOSE`. `PORT=8770` is baked into the image and set as a
  service variable so the probe and uvicorn agree; without it the deployment
  fails `HEALTHCHECK` five minutes after a perfectly good startup.

Railway must be able to pull the image. Two ways, pick one:

**(a) Make the GHCR package public** — this is what is in force. Verify
anonymously (200 = public):

```bash
T=$(curl -s "https://ghcr.io/token?scope=repository:ryan-the-brodsky/cutroom-demo:pull" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $T" \
  -H 'Accept: application/vnd.oci.image.index.v1+json' \
  https://ghcr.io/v2/ryan-the-brodsky/cutroom-demo/manifests/latest
```

If it ever reverts to private, flip it back with a `write:packages` token
(`gh auth refresh -h github.com -s write:packages`) or the web UI:

```bash
gh api -X PATCH /user/packages/container/cutroom-demo -f visibility=public
# or: github.com/users/ryan-the-brodsky/packages/container/cutroom-demo/settings
#     → Danger Zone → Change visibility → Public
```

**(b) Give Railway registry credentials and keep the image private.** Railway's
public GraphQL API takes them on `serviceInstanceUpdate`; the password is a
GitHub token with `read:packages`
(`gh auth refresh -h github.com -s read:packages`). Verified against the live
schema: `ServiceInstanceUpdateInput.registryCredentials: RegistryCredentialsInput{username, password}`.

```bash
RW_TOK=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.railway/config.json')))['user']['accessToken'])")
GH_TOK=$(gh auth token)   # must carry read:packages

python3 -c '
import json, os
print(json.dumps({
  "query": "mutation($s:String!,$e:String!,$i:ServiceInstanceUpdateInput!)"
           "{serviceInstanceUpdate(serviceId:$s,environmentId:$e,input:$i)}",
  "variables": {
    "s": "432042c8-5b3b-4ac4-9bdc-8c60a5ed3e97",
    "e": "aa83e186-a468-4901-aa8f-f1093013caf8",
    "i": {"registryCredentials": {"username": "ryan-the-brodsky",
                                  "password": os.environ["GH_TOK"]}}}}))' \
  > /tmp/regcreds.json

curl -s https://backboard.railway.com/graphql/v2 \
  -H "Authorization: Bearer $RW_TOK" -H 'Content-Type: application/json' \
  --data @/tmp/regcreds.json
rm -f /tmp/regcreds.json

railway redeploy --service cutroom -y
```

Without one of these the deployment fails at `CREATE_CONTAINER` with
*"We were unable to connect to the registry for this image."*

### Variables (names only — values live in Railway and your local env file)

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
- `CUTROOM_ADMIN_TOKEN` — the owner only, 32 chars. Required to edit backends,
  lanes, keys, import, delete or pause.
- `CUTROOM_WORKER_TOKEN` — remote worker job claims.

Demo policy (workstream B's caps): `CUTROOM_DEMO_PAID_JOBS_PER_HOUR=12`,
`CUTROOM_DEMO_JOBS_PER_MIN=60`, `CUTROOM_DEMO_PROJECT=next-year`.

Provider keys (Addendum A; anything unset falls back to the `mock` lane). All
set. The server accepts either spelling for fal and ElevenLabs, so both are
set: `OPENROUTER_API_KEY`, `FAL_KEY`, `FAL_AI_API_KEY`, `ELEVEN_LABS_API_KEY`,
`ELEVENLABS_API_KEY`.

Lane defaults and the models behind them:

| name | value |
|---|---|
| `CUTROOM_LANE_DIRECTION` | `openrouter:z-ai/glm-5.3-flash` |
| `CUTROOM_LANE_STILL` | `openrouter-image:google/gemini-2.5-flash-image` |
| `CUTROOM_LANE_I2I` | `openrouter-image:google/gemini-2.5-flash-image` |
| `CUTROOM_LANE_MOTION` | `fal:fal-ai/wan/v2.2-a14b/image-to-video/turbo` |
| `CUTROOM_LANE_VO` | `elevenlabs` |
| `CUTROOM_OPENROUTER_MODEL` | `z-ai/glm-5.3-flash` |
| `CUTROOM_OPENROUTER_IMAGE_MODEL` | `google/gemini-2.5-flash-image` |
| `CUTROOM_FAL_MOTION_MODEL` | `fal-ai/wan/v2.2-a14b/image-to-video/turbo` |

SFX and music lanes are deliberately unset, so they fall back to `mock`.

### Demo data

The bundle is film footage, not code, and it must **not** become public when the
code repo does. So it lives on its own permanently-private repo,
**`ryan-the-brodsky/cutroom-demo-data`**, as release `demo-data-v1` (asset id
`540318287`). Nothing about the bundle is stored in this repository.

Built with `cutroom demo-bundle` from a private studio folder:

```bash
server/.venv/bin/cutroom demo-bundle \
  <path-to-a-studio-folder> \
  /tmp/cutroom-D/demo-data-v1.tar.zst          # 941 files, 290 MB raw -> 278 MB

gh release create demo-data-v1 /tmp/cutroom-D/demo-data-v1.tar.zst \
  --repo ryan-the-brodsky/cutroom-demo-data --title "Demo data v1 (next-year)"
gh api repos/ryan-the-brodsky/cutroom-demo-data/releases/tags/demo-data-v1 \
  --jq '.assets[].id'
```

- `CUTROOM_DEMO_BUNDLE` =
  `https://api.github.com/repos/ryan-the-brodsky/cutroom-demo-data/releases/assets/540318287`
  — **set**.
- `CUTROOM_DEMO_BUNDLE_TOKEN` — **required, and not yet set.** The data repo is
  private and stays private, so unlike the code repo this token never becomes
  optional: without it the boot importer cannot download the asset and the demo
  comes up with no film. It must be a *fine-grained* PAT scoped to
  **`cutroom-demo-data` only**, with **Contents: Read-only**
  (<https://github.com/settings/personal-access-tokens/new>).
  Do **not** use `gh auth token` here: that is an account-wide OAuth token with
  `repo` write access to every repository the account owns, and this env var
  lives on a public-facing demo host.

At boot, if no projects exist, the server downloads the bundle into
`$CUTROOM_DATA/demo-src` and imports it as project `next-year`. Force it by
hand with `railway ssh --service cutroom` then `cutroom demo-import`.

```bash
railway variables --set 'NAME=value'          # add or change one
railway variables                             # list (values shown — do not paste)
```

### Rotating tokens

```bash
NEW=$(openssl rand -hex 16)
railway variables --set "CUTROOM_ADMIN_TOKEN=$NEW"   # redeploys automatically
```

Then update the matching line in your local env file
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

### Repo rename

The GitHub repository was renamed from `cutroom` to `genga-studio` along with
the product. GitHub keeps a permanent redirect from the old path, so existing
clone URLs, configured `git remote` entries and the `ryan-the-brodsky/cutroom`
links in these docs all keep resolving. The GHCR image path
(`ghcr.io/ryan-the-brodsky/cutroom-demo`) is a separate namespace and did not
change.

### Flipping the repo public

Required for submission — judges must see the source and the MIT license in
the About box. On the owner's explicit word only:

```bash
gh repo edit ryan-the-brodsky/cutroom \
  --visibility public --accept-visibility-change-consequences
gh repo view ryan-the-brodsky/cutroom --json isPrivate,licenseInfo
```

Check first that nothing private has crept in: the film's script, style bible
and prompts live in the private parent repository and must stay there, and no
`.env`, token or provider key may be in the history
(`git log -p | grep -iE 'api[_-]?key|token'`). Note that
`CUTROOM_DEMO_BUNDLE_TOKEN` is **not** dropped when this repo goes public — the
bundle lives on the separate, permanently private `cutroom-demo-data` repo, so
its read token is still needed.
