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
COPY --from=web /web/dist ./server/cutroom/static
RUN pip install --no-cache-dir ./server
ENV CUTROOM_DATA=/data \
    CUTROOM_HOST=0.0.0.0 \
    CUTROOM_PORT=8770
VOLUME /data
EXPOSE 8770
CMD ["cutroom"]
