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

# TikTok sometimes returns a 200 HTML page for a short URL while the actual
# photo URL is exposed through canonical/og:url metadata. Make the resolver
# use that URL before yt-dlp gets a chance to treat a photo post as a video.
RUN python3 -c "from pathlib import Path; p=Path('server.js'); s=p.read_text(); old='''async function fetchTikTokPage(url) { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 30000); try { const response = await fetch(url, { redirect: \'follow\', signal: controller.signal, headers: TIKTOK_HEADERS }); if (!response.ok) throw new Error(`TikTok returned HTTP ${response.status}.`); return { finalUrl: response.url || url, html: await response.text() }; } finally { clearTimeout(timer); } }'''; new='''function extractTikTokCanonicalUrl(html, fallback) { const patterns = [/<link[^>]+rel=[\\\"\\\']canonical[\\\"\\\'][^>]+href=[\\\"\\\']([^\\\"\\\']+)[\\\"\\\']/i, /<meta[^>]+property=[\\\"\\\']og:url[\\\"\\\'][^>]+content=[\\\"\\\']([^\\\"\\\']+)[\\\"\\\']/i, /<meta[^>]+name=[\\\"\\\']twitter:url[\\\"\\\'][^>]+content=[\\\"\\\']([^\\\"\\\']+)[\\\"\\\']/i]; for (const pattern of patterns) { const match = html.match(pattern); if (!match) continue; try { const candidate = new URL(match[1].replace(/&amp;/g, \'&\'), fallback); if (isTikTokHost(candidate.hostname)) return candidate.toString(); } catch {} } const embedded = html.match(/(?:https?:\\/\\/(?:www\\.)?tiktok\\.com)?\\/[^\\\"\\\'\\s<>]*\\/photo\\/(\\d+)/i); if (embedded) { try { const base = new URL(fallback); return `https://${base.hostname}/photo/${embedded[1]}`; } catch {} } return fallback; }\n\nasync function fetchTikTokPage(url) { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 30000); try { const response = await fetch(url, { redirect: \'follow\', signal: controller.signal, headers: TIKTOK_HEADERS }); if (!response.ok) throw new Error(`TikTok returned HTTP ${response.status}.`); const html = await response.text(); const networkUrl = response.url || url; const finalUrl = extractTikTokCanonicalUrl(html, networkUrl); return { finalUrl, html }; } finally { clearTimeout(timer); } }''';\nassert old in s, 'fetchTikTokPage block not found'; p.write_text(s.replace(old,new))"

RUN mkdir -p /data/downloads

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
