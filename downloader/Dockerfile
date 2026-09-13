FROM node:22-slim

# yt-dlp needs Python; ffmpeg is required for merging video+audio and audio extraction.
# curl_cffi gives yt-dlp browser impersonation support required by some sites.
# Node 22 is required by current yt-dlp-ejs releases for YouTube challenge solving.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    ca-certificates \
    git \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir --break-system-packages -U "yt-dlp[default,curl-cffi]" \
    && pip3 install --no-cache-dir --break-system-packages -U "bgutil-ytdlp-pot-provider==2.0.0" \
    && pip3 install --no-cache-dir --break-system-packages -U you-get gallery-dl \
    && yt-dlp --version \
    && you-get --version \
    && gallery-dl --version

# Keep Node/EJS enabled and use yt-dlp's normal YouTube clients plus the embedded fallback.
# Do not force mweb globally because current YouTube behavior can reject it from datacenter IPs.
RUN printf '%s\n' \
    '--js-runtimes node' \
    '--extractor-retries 3' \
    '--retries 3' \
    '--fragment-retries 3' \
    '--file-access-retries 3' \
    '--extractor-args "youtube:player_client=default,web_embedded"' \
    '--extractor-args "youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416"' \
    > /etc/yt-dlp.conf \
    && node --version \
    && yt-dlp --version

# Build the current BgUtils PO-token provider. The HTTP provider stays running beside the downloader.
RUN git clone --depth 1 --branch 2.0.0 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /opt/bgutil-ytdlp-pot-provider \
    && cd /opt/bgutil-ytdlp-pot-provider/server \
    && npm ci --no-audit --no-fund \
    && npx tsc

WORKDIR /app

COPY downloader/package*.json ./
RUN npm install --omit=dev

COPY downloader/ ./

# Keep the existing build-time compatibility patches, plus universal diagnostics/fallback routing.
RUN python3 patch-tiktok.py \
    && python3 patch-runtime.py \
    && python3 patch-stage-ui.py \
    && python3 patch-preview.py \
    && python3 patch-photo-audio.py \
    && python3 patch-tiktok-special.py \
    && python3 patch-tiktok-photo-disable.py \
    && python3 patch-audio-preview.py \
    && python3 patch-history-api.py \
    && python3 patch-diagnostics.py \
    && node --check server.js \
    && rm -f patch-tiktok.py patch-runtime.py patch-stage-ui.py patch-preview.py patch-photo-audio.py patch-tiktok-special.py patch-tiktok-photo-disable.py patch-audio-preview.py patch-history-api.py patch-diagnostics.py

RUN mkdir -p /data/downloads

ENV PORT=3000
EXPOSE 3000

# Keep provider diagnostics visible in Render and wait until the provider is ready before starting the app.
CMD ["sh", "-c", "set -eu; node /opt/bgutil-ytdlp-pot-provider/server/build/main.js & provider_pid=$!; trap 'kill $provider_pid 2>/dev/null || true' TERM INT EXIT; ready=0; for i in $(seq 1 30); do if curl -fsS http://127.0.0.1:4416/ping >/dev/null 2>&1; then echo '[bgutil] provider ready on 127.0.0.1:4416'; ready=1; break; fi; if ! kill -0 $provider_pid 2>/dev/null; then echo '[bgutil] provider exited during startup'; wait $provider_pid || true; exit 1; fi; sleep 1; done; if [ \"$ready\" -ne 1 ]; then echo '[bgutil] provider did not become ready within 30s'; exit 1; fi; exec node server.js"]
