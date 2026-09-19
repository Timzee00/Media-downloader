const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const API_BASE = 'https://curiousapis.name.ng/aio_downloader';
const ENDPOINT = '/download/aio';
const TIMEOUT_MS = Math.max(15000, Number(process.env.CURIOUSAPI_TIMEOUT_MS || 90000));

function buildEndpoint(sourceUrl) {
  return API_BASE + ENDPOINT + '?url=' + encodeURIComponent(sourceUrl);
}

function firstValue(root, keys) {
  if (!root || typeof root !== 'object') return null;
  const wanted = new Set(keys.map(key => key.toLowerCase()));
  const seen = new Set();

  function walk(value) {
    if (!value || typeof value !== 'object' || seen.has(value)) return null;
    seen.add(value);

    for (const [key, child] of Object.entries(value)) {
      if (wanted.has(String(key).toLowerCase()) && child !== null && child !== undefined && child !== '') {
        return child;
      }
    }
    for (const child of Object.values(value)) {
      const found = walk(child);
      if (found !== null && found !== undefined && found !== '') return found;
    }
    return null;
  }

  return walk(root);
}

function extractDownloadUrl(data) {
  const value = firstValue(data, [
    'downloadUrl', 'download_url', 'downloadLink', 'download_link',
    'mediaUrl', 'media_url', 'fileUrl', 'file_url', 'link', 'url'
  ]);
  return typeof value === 'string' && /^https?:\/\//i.test(value) ? value : null;
}

function extractMetadata(data) {
  const duration = firstValue(data, ['duration', 'length']);
  return {
    title: firstValue(data, ['title', 'name', 'filename', 'fileName']),
    thumbnail: firstValue(data, ['thumbnail', 'thumbnailUrl', 'thumbnail_url', 'cover', 'coverUrl', 'cover_url']),
    duration: duration === null || duration === undefined ? null : duration,
    uploader: firstValue(data, ['uploader', 'channel', 'author', 'username', 'creator']),
    extractor: firstValue(data, ['extractor', 'platform', 'source', 'site'])
  };
}

function filenameFromHeaders(headers) {
  const disposition = headers.get('content-disposition') || '';
  const match = disposition.match(/filename\*=UTF-8''([^;]+)|filename="([^"]+)"|filename=([^;\s]+)/i);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1] || match[2] || match[3]);
  } catch {
    return match[1] || match[2] || match[3];
  }
}

function safeFilename(value, fallback = 'download') {
  const base = path.basename(String(value || '').trim()).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
  return base || fallback;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, redirect: 'follow', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function streamToFile(response, filePath, maxBytes) {
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > maxBytes) throw new Error('CuriousAPI returned a file larger than the configured download limit.');

  const file = fs.createWriteStream(filePath, { flags: 'w' });
  let total = 0;
  try {
    const readable = response.body instanceof Readable
      ? response.body
      : Readable.fromWeb(response.body);

    for await (const chunk of readable) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        file.destroy();
        try { fs.unlinkSync(filePath); } catch {}
        throw new Error('CuriousAPI returned a file larger than the configured download limit.');
      }
      if (!file.write(buffer)) {
        await new Promise((resolve, reject) => {
          const onDrain = () => { cleanup(); resolve(); };
          const onError = error => { cleanup(); reject(error); };
          const cleanup = () => {
            file.off('drain', onDrain);
            file.off('error', onError);
          };
          file.once('drain', onDrain);
          file.once('error', onError);
        });
      }
    }
    await new Promise((resolve, reject) => {
      file.once('finish', resolve);
      file.once('error', reject);
      file.end();
    });
  } catch (error) {
    file.destroy();
    try { fs.unlinkSync(filePath); } catch {}
    throw error;
  }
  return total;
}

async function downloadToFile(sourceUrl, destinationPath, options = {}) {
  const maxBytes = Math.max(1, Number(options.maxBytes || 1024 * 1024 * 1024));
  let response = await fetchWithTimeout(buildEndpoint(sourceUrl), {
    headers: { Accept: 'application/json, video/*, audio/*, application/octet-stream;q=0.9, */*;q=0.5' }
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error('CuriousAPI returned HTTP ' + response.status + (text ? ': ' + text.slice(0, 300) : '.'));
  }

  let metadata = {};
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();

  if (contentType.includes('application/json') || contentType.includes('+json')) {
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('CuriousAPI returned invalid JSON.');
    }
    metadata = extractMetadata(data);
    const downloadUrl = extractDownloadUrl(data);
    if (!downloadUrl) throw new Error('CuriousAPI response did not include a downloadable media URL.');

    response = await fetchWithTimeout(downloadUrl, {
      headers: { Accept: 'video/*, audio/*, application/octet-stream;q=0.9, */*;q=0.5' }
    });
    if (!response.ok) throw new Error('CuriousAPI media URL returned HTTP ' + response.status + '.');
  }

  const finalType = String(response.headers.get('content-type') || '').toLowerCase();
  const filename = safeFilename(filenameFromHeaders(response.headers) || metadata.title || 'download');
  if (finalType.includes('text/html') || finalType.includes('application/json')) {
    throw new Error('CuriousAPI returned a non-media response.');
  }

  const fileSize = await streamToFile(response, destinationPath, maxBytes);
  return {
    fileSize,
    metadata: {
      ...metadata,
      title: metadata.title || filename.replace(/\.[^.]+$/, ''),
    },
    contentType: finalType || 'application/octet-stream',
    filename,
  };
}

module.exports = {
  buildEndpoint,
  extractDownloadUrl,
  extractMetadata,
  downloadToFile,
};
