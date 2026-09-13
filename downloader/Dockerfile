FROM node:20-slim

# yt-dlp needs Python; ffmpeg is required for merging video+audio and for audio extraction/transcoding.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir --break-system-packages -U yt-dlp

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

RUN mkdir -p /data/downloads

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
