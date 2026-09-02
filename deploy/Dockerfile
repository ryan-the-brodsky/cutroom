# Cutroom — single-image deploy (API + SPA + in-process workers).
# GPU generation happens on ComfyUI hosts you point backends at; this image
# only needs ffmpeg + python.
#   docker build -f deploy/Dockerfile -t cutroom .

FROM node:22-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json* ./
RUN npm install --no-fund --no-audit
COPY web/ .
RUN npm run build

FROM python:3.12-slim
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server/ ./server/
RUN pip install --no-cache-dir ./server

# The SPA has to land in the INSTALLED package, not the source tree: setuptools
# only packages directories that are importable, and `static/` has no
# __init__.py, so anything copied to server/cutroom/static before `pip install`
# is silently dropped and the server never registers its SPA route (main.py
# only mounts it `if static.is_dir()`) — every non-API path then 404s.
COPY --from=web /web/dist /tmp/spa
RUN PKG="$(python -c 'import cutroom, pathlib; print(pathlib.Path(cutroom.__file__).parent)')" && \
    rm -rf "$PKG/static" && cp -r /tmp/spa "$PKG/static" && \
    rm -rf /tmp/spa && \
    test -f "$PKG/static/index.html" && test -d "$PKG/static/assets"

ENV CUTROOM_DATA=/data \
    CUTROOM_HOST=0.0.0.0 \
    CUTROOM_PORT=8770 \
    PORT=8770
VOLUME /data
EXPOSE 8770
CMD ["cutroom"]
