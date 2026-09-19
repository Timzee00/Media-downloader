FROM node:22-slim

# Deno is yt-dlp's recommended JavaScript runtime for current YouTube EJS.
# Use the official Deno binary image so we don't rely on an installer script.
COPY --from=denoland/deno:bin-2.9.6 /deno /usr/local/bin/deno

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
    && deno --version \
    && node --version \
    && you-get --version \
    && gallery-dl --version

RUN printf '%s\n' \
    '--js-runtimes node' \
    '--extractor-retries 3' \
    '--retries 3' \
    '--fragment-retries 3' \
    '--file-access-retries 3' \
    '--extractor-args "youtube:player_client=default,web_embedded"' \
    '--extractor-args "youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416"' \
    > /etc/yt-dlp.conf \
    && yt-dlp --version

RUN git clone --depth 1 --branch 2.0.0 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /opt/bgutil-ytdlp-pot-provider \
    && cd /opt/bgutil-ytdlp-pot-provider/server \
    && npm ci --no-audit --no-fund \
    && npx tsc

WORKDIR /app

COPY downloader/package*.json ./
RUN npm install --omit=dev

COPY downloader/ ./

# Apply all existing compatibility/stability patches first, then add the
# optional external provider against the final transformed server.js.
RUN python3 patch-tiktok.py \
    && python3 patch-runtime.py \
    && python3 patch-stage-ui.py \
    && python3 patch-preview.py \
    && python3 patch-photo-audio.py \
    && python3 patch-tiktok-special.py \
    && python3 patch-audio-preview.py \
    && python3 patch-history-api.py \
    && python3 patch-diagnostics.py \
    && python3 patch-queue.py \
    && python3 patch-hardening-brand.py \
    && python3 patch-production-hardening.py \
    && python3 patch-provider-router.py \
    && node --check server.js \
    && node --check provider-router.js \
    && node --check queue-manager.js \
    && node --check download-utils.js \
    && node --test provider-router.test.js queue-manager.test.js platform-providers.test.js download-utils.test.js providers/curiousapi.test.js \
    && rm -f patch-tiktok.py patch-runtime.py patch-stage-ui.py patch-preview.py patch-photo-audio.py patch-tiktok-special.py patch-audio-preview.py patch-history-api.py patch-diagnostics.py patch-queue.py patch-hardening-brand.py patch-production-hardening.py patch-provider-router.py

RUN mkdir -p /data/downloads
COPY downloader/start.sh /app/start.sh
RUN chmod +x /app/start.sh

ENV PORT=3000
EXPOSE 3000
CMD ["/app/start.sh"]