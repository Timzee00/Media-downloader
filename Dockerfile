FROM node:22-slim

# yt-dlp needs Python; ffmpeg is required for merging video+audio and audio extraction.
# curl_cffi gives yt-dlp browser impersonation support required by some sites such as TikTok.
# Node 22 is also required by current yt-dlp-ejs releases for YouTube challenge solving.
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
    && yt-dlp --version

# yt-dlp enables Deno by default, but this container already has Node 22.
# Explicitly enable Node so YouTube's EJS challenge solver can run.
RUN printf '%s\n' \
    '--js-runtimes node' \
    '--extractor-retries 3' \
    '--retries 3' \
    '--fragment-retries 3' \
    '--file-access-retries 3' \
    '--extractor-args "youtube:player_client=mweb"' \
    '--extractor-args "youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416"' \
    > /etc/yt-dlp.conf \
    && node --version \
    && yt-dlp --version

# Build the current BgUtils PO-token provider. The HTTP provider is kept running
# beside the downloader so yt-dlp can request fresh per-video tokens without
# spawning a Node process for every yt-dlp invocation.
RUN git clone --depth 1 --branch 2.0.0 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /opt/bgutil-ytdlp-pot-provider \
    && cd /opt/bgutil-ytdlp-pot-provider/server \
    && npm ci --no-audit --no-fund \
    && npx tsc

WORKDIR /app

COPY downloader/package*.json ./
RUN npm install --omit=dev

COPY downloader/ ./

# Use normal Python patch scripts instead of deeply quoted Docker one-liners.
RUN python3 patch-tiktok.py \
    && python3 patch-runtime.py \
    && python3 patch-stage-ui.py \
    && python3 patch-preview.py \
    && python3 patch-photo-audio.py \
    && python3 patch-tiktok-special.py \
    && python3 patch-tiktok-photo-disable.py \
    && python3 patch-audio-preview.py \
    && python3 patch-history-api.py \
    && node --check server.js \
    && rm -f patch-tiktok.py patch-runtime.py patch-stage-ui.py patch-preview.py patch-photo-audio.py patch-tiktok-special.py patch-tiktok-photo-disable.py patch-audio-preview.py patch-history-api.py

RUN mkdir -p /data/downloads

ENV PORT=3000
EXPOSE 3000

# Run the POT provider on loopback and the downloader as the main process.
# Render only exposes the app's PORT; the token provider stays private inside
# the container and is reachable at 127.0.0.1:4416.
CMD ["sh", "-c", "node /opt/bgutil-ytdlp-pot-provider/server/build/main.js >/tmp/bgutil-provider.log 2>&1 & exec node server.js"]
