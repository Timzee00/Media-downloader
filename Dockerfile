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

# The application lives in /downloader in this repository.
COPY downloader/package*.json ./
RUN npm install --omit=dev

COPY downloader/ ./

RUN mkdir -p /data/downloads

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
