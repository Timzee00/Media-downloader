FROM node:20-slim

# yt-dlp needs Python; ffmpeg is required for merging video+audio and audio extraction.
# curl_cffi gives yt-dlp browser impersonation support required by some sites such as TikTok.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir --break-system-packages -U "yt-dlp[default,curl-cffi]" \
    && yt-dlp --version \
    && yt-dlp --list-impersonate-targets

WORKDIR /app

COPY downloader/package*.json ./
RUN npm install --omit=dev

COPY downloader/ ./

# Use normal Python patch scripts instead of a deeply quoted Docker one-liner.
RUN python3 patch-tiktok.py \
    && python3 patch-runtime.py \
    && python3 patch-stage-ui.py \
    && node --check server.js \
    && rm -f patch-tiktok.py patch-runtime.py patch-stage-ui.py

RUN mkdir -p /data/downloads

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
