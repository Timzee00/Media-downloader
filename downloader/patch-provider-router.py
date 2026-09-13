from pathlib import Path

path = Path('server.js')
text = path.read_text(encoding='utf-8')

if 'OPTIONAL BACKEND ROUTER' in text:
    raise SystemExit('Optional backend router already applied')

marker = '// ---------- TikTok photo/slideshow support ----------'
block = r'''
// ---------- OPTIONAL BACKEND ROUTER ----------
// The main extractor remains yt-dlp. Optional remote backends are only used
// when explicitly configured, so deployments do not silently depend on an
// unknown public service.
const PIPED_API_URL = String(process.env.PIPED_API_URL || '').replace(/\/$/, '');
const PIPED_TIMEOUT_MS = Number(process.env.PIPED_TIMEOUT_MS || 30000);

function providerEnabled(name) {
  return name === 'piped' ? Boolean(PIPED_API_URL) : false;
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = PIPED_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const body = await response.text();
    let data = null;
    try { data = body ? JSON.parse(body) : null; } catch {}
    if (!response.ok) {
      throw new Error(`Remote provider returned HTTP ${response.status}: ${compactDetail(body, 700)}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function youtubeIdFromUrl(value) {
  try {
    const url = new URL(value);
    if (url.hostname === 'youtu.be') return url.pathname.slice(1).split('/')[0] || null;
    if (url.hostname.endsWith('youtube.com')) {
      if (url.pathname === '/watch') return url.searchParams.get('v');
      const match = url.pathname.match(/^\/(?:shorts|embed|live)\/([^/?]+)/);
      return match ? match[1] : null;
    }
  } catch {}
  return null;
}

async function resolvePipedInfo(url) {
  if (!providerEnabled('piped')) throw new Error('Piped backend is not configured.');
  const videoId = youtubeIdFromUrl(url);
  if (!videoId) throw new Error('Piped backend currently handles YouTube URLs only.');
  return fetchJsonWithTimeout(`${PIPED_API_URL}/streams/${encodeURIComponent(videoId)}`);
}

async function downloadRemoteFile(url, destination, referer = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ENGINE_TIMEOUT_MS);
  try {
    const headers = referer ? { Referer: referer } : {};
    const response = await fetch(url, { redirect: 'follow', headers, signal: controller.signal });
    if (!response.ok) throw new Error(`Remote media server returned HTTP ${response.status}.`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) throw new Error('Remote provider returned an empty file.');
    fs.writeFileSync(destination, buffer);
    return { size: buffer.length, contentType: response.headers.get('content-type') || null };
  } finally {
    clearTimeout(timer);
  }
}

function choosePipedVideo(info, quality) {
  const streams = Array.isArray(info?.videoStreams) ? info.videoStreams.slice() : [];
  if (!streams.length) return null;
  const heightLimit = quality === '2160p' ? 2160 : quality === '1440p' ? 1440 : quality === '1080p' ? 1080 : quality === '720p' ? 720 : quality === '480p' ? 480 : quality === '360p' ? 360 : Infinity;
  const candidates = streams.filter(item => item?.url && Number(item.height || 0) <= heightLimit);
  const pool = candidates.length ? candidates : streams.filter(item => item?.url);
  pool.sort((a, b) => Number(b.height || 0) - Number(a.height || 0));
  return pool[0] || null;
}

async function runPipedFallback(url, id, quality, type) {
  const info = await resolvePipedInfo(url);
  if (type === 'audio') {
    const audio = Array.isArray(info?.audioStreams) ? info.audioStreams.find(item => item?.url) : null;
    if (!audio) throw new Error('Piped did not provide an audio stream.');
    const ext = /audio\/mp4|m4a/i.test(audio.mimeType || '') ? 'm4a' : 'webm';
    const destination = path.join(DOWNLOAD_DIR, `${id}-piped.${ext}`);
    const downloaded = await downloadRemoteFile(audio.url, destination, url);
    return { filePath: path.basename(destination), fileSize: downloaded.size, info };
  }
  const stream = choosePipedVideo(info, quality);
  if (!stream) throw new Error('Piped did not provide a compatible video stream.');
  const extension = /webm/i.test(stream.mimeType || '') ? 'webm' : 'mp4';
  const destination = path.join(DOWNLOAD_DIR, `${id}-piped.${extension}`);
  const downloaded = await downloadRemoteFile(stream.url, destination, url);
  return { filePath: path.basename(destination), fileSize: downloaded.size, info };
}

if (!global.__MEDIA_DOWNLOADER_PROVIDER_DIAG__) {
  global.__MEDIA_DOWNLOADER_PROVIDER_DIAG__ = true;
  diagLog('provider_config', {
    pipedEnabled: providerEnabled('piped'),
    pipedHost: PIPED_API_URL ? safeHost(PIPED_API_URL) : null
  });
}

'''
if marker not in text:
    raise SystemExit('Expected TikTok marker not found')
text = text.replace(marker, block + marker, 1)

# Add Piped to metadata resolution only when explicitly configured.
needle = "    } catch (primaryError) {\n      // Metadata is helpful but should not prevent the actual download route\n      // from trying its independent fallback engine.\n      diagLog('metadata_degraded', { urlHost: safeHost(url), primary: 'yt-dlp', detail: compactDetail(primaryError.message, 900) });\n      return res.json({"
replacement = "    } catch (primaryError) {\n      if (providerEnabled('piped')) {\n        try {\n          const piped = await resolvePipedInfo(url);\n          return res.json({\n            title: piped.title || `Media from ${safeHost(url)}`,\n            thumbnail: piped.thumbnailUrl || null,\n            duration: Number.isFinite(Number(piped.duration)) ? Number(piped.duration) : null,\n            uploader: piped.uploader || null,\n            extractor: 'Piped',\n            contentType: 'video',\n            availableHeights: [...new Set((piped.videoStreams || []).map(item => Number(item.height)).filter(Boolean))].sort((a, b) => b - a)\n          });\n        } catch (providerError) {\n          diagLog('provider_metadata_failure', { provider: 'piped', urlHost: safeHost(url), detail: compactDetail(providerError.message, 700) });\n        }\n      }\n      // Metadata is helpful but should not prevent the actual download route\n      // from trying its independent fallback engines.\n      diagLog('metadata_degraded', { urlHost: safeHost(url), primary: 'yt-dlp', detail: compactDetail(primaryError.message, 900) });\n      return res.json({"
if needle in text:
    text = text.replace(needle, replacement, 1)
else:
    raise SystemExit('Expected metadata fallback block not found')

old = r'''    } catch (fallbackError) {
      diagLog('fallback_failure', { requestId: job.id, from: 'yt-dlp', to: 'you-get', urlHost: safeHost(job.url), detail: compactDetail(fallbackError.message, 1000) });
      throw new Error(`Primary engine failed and fallback engine also failed. Primary: ${compactDetail(primaryError.message, 500)} Fallback: ${compactDetail(fallbackError.message, 500)}`);
    }
  }
'''
new = r'''    } catch (fallbackError) {
      diagLog('fallback_failure', { requestId: job.id, from: 'yt-dlp', to: 'you-get', urlHost: safeHost(job.url), detail: compactDetail(fallbackError.message, 1000) });
      if (providerEnabled('piped')) {
        diagLog('fallback_start', { requestId: job.id, from: 'you-get', to: 'piped', urlHost: safeHost(job.url) });
        try {
          const remote = await runPipedFallback(job.url, id, job.quality, job.type);
          const pipedInfo = remote.info || {};
          const updated = getJob(id);
          updated.status = 'done';
          updated.title = pipedInfo.title || 'Untitled';
          updated.thumbnail = pipedInfo.thumbnailUrl || null;
          updated.duration = Number.isFinite(Number(pipedInfo.duration)) ? Number(pipedInfo.duration) : null;
          updated.sourcePlatform = 'Piped';
          updated.filePath = remote.filePath;
          updated.fileSize = remote.fileSize;
          await upsertJob(updated);
          return;
        } catch (providerError) {
          diagLog('fallback_failure', { requestId: job.id, from: 'you-get', to: 'piped', urlHost: safeHost(job.url), detail: compactDetail(providerError.message, 1000) });
        }
      }
      throw new Error(`Primary engine failed and all configured fallbacks failed. Primary: ${compactDetail(primaryError.message, 400)} You-get: ${compactDetail(fallbackError.message, 400)}`);
    }
  }
'''
if old not in text:
    raise SystemExit('Expected video fallback block not found')
text = text.replace(old, new, 1)

path.write_text(text, encoding='utf-8')
print('Optional backend router patch applied')
