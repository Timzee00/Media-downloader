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
    && pip3 install --no-cache-dir --break-system-packages -U you-get gallery-dl \
    && yt-dlp --version \
    && you-get --version \
    && gallery-dl --version

# Keep Node/EJS enabled and let current yt-dlp choose its normal YouTube clients.
# web_embedded is an additional fallback that does not require a GVS PO token,
# while the BgUtils provider remains available for clients that do require one.
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

# Build the current BgUtils PO-token provider. The HTTP provider is kept running
# beside the downloader so yt-dlp can request fresh per-video tokens when needed.
RUN git clone --depth 1 --branch 2.0.0 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /opt/bgutil-ytdlp-pot-provider \
    && cd /opt/bgutil-ytdlp-pot-provider/server \
    && npm ci --no-audit --no-fund \
    && npx tsc

WORKDIR /app

COPY downloader/package*.json ./
RUN npm install --omit=dev

COPY downloader/ ./

# Apply the existing platform/UI compatibility patches and universal diagnostics.
# The provider router is part of the runtime backend and is loaded by patch-diagnostics.py.
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
    && node --check provider-router.js \
    && rm -f patch-tiktok.py patch-runtime.py patch-stage-ui.py patch-preview.py patch-photo-audio.py patch-tiktok-special.py patch-tiktok-photo-disable.py patch-audio-preview.py patch-history-api.py patch-diagnostics.py patch-provider-router.py

RUN mkdir -p /data/downloads

# Copy the dedicated startup script explicitly so the active root Dockerfile
# always contains the exact startup entrypoint used by Render.
COPY downloader/start.sh /app/start.sh
RUN chmod +x /app/start.sh

ENV PORT=3000
EXPOSE 3000

# Use the dedicated script instead of a long JSON shell command. This avoids
# Render/Docker misparsing the command as an executable named "[sh,".
CMD ["/app/start.sh"]
