'use strict';

const fs = require('fs');
const path = require('path');

const QUALITY_LIMITS = Object.freeze({
  best: null,
  '2160p': 2160,
  '1440p': 1440,
  '1080p': 1080,
  '720p': 720,
  '480p': 480,
  '360p': 360,
});

function videoFormatFor(quality = 'best') {
  const height = QUALITY_LIMITS[quality] ?? null;
  if (!height) return 'bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b';
  return `bv*[height<=${height}][ext=mp4]+ba[ext=m4a]/bv*[height<=${height}]+ba/b[height<=${height}]/b`;
}

const QUALITY_FORMATS = Object.freeze(
  Object.fromEntries(Object.keys(QUALITY_LIMITS).map(quality => [quality, videoFormatFor(quality)]))
);

function isTemporaryDownloadFile(name) {
  return /\.(part|ytdl|download|tmp)$/i.test(name);
}

function outputMatchesType(name, type) {
  const ext = path.extname(name).toLowerCase();
  if (type === 'audio') return ['.mp3', '.m4a', '.aac', '.opus', '.ogg', '.wav', '.webm'].includes(ext);
  return ['.mp4', '.mkv', '.webm', '.mov', '.avi', '.flv'].includes(ext);
}

function selectCompletedOutput(downloadDir, jobId, type = 'video') {
  const candidates = fs.readdirSync(downloadDir)
    .filter(name => name.startsWith(jobId))
    .filter(name => !isTemporaryDownloadFile(name))
    .filter(name => outputMatchesType(name, type))
    .map(name => {
      const fullPath = path.join(downloadDir, name);
      try {
        const stat = fs.statSync(fullPath);
        return stat.isFile() ? { name, fullPath, size: stat.size, mtimeMs: stat.mtimeMs } : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => (b.mtimeMs - a.mtimeMs) || (b.size - a.size));

  return candidates[0] || null;
}

function cleanupJobFiles(downloadDir, jobId) {
  let removed = 0;
  for (const name of fs.readdirSync(downloadDir)) {
    if (!name.startsWith(jobId)) continue;
    try {
      fs.unlinkSync(path.join(downloadDir, name));
      removed += 1;
    } catch {}
  }
  return removed;
}

function normalizeDownloadError(error) {
  const raw = String(error?.message || error || '').replace(/\s+/g, ' ').trim();
  const text = raw.toLowerCase();

  if (text.includes('unsupported url')) {
    return 'That link is not supported by the available download providers.';
  }
  if (text.includes('requested format is not available') || text.includes('no video formats found')) {
    return 'The requested quality is not available for this media. Try Best available or a lower quality.';
  }
  if (text.includes('sign in to confirm you’re not a bot') || text.includes("sign in to confirm you're not a bot") || text.includes('http error 403') || text.includes('403 forbidden')) {
    return 'The source platform rejected the downloader server request. Try another public link or try again later.';
  }
  if (text.includes('timed out') || text.includes('timeout') || text.includes('read timed out')) {
    return 'The source took too long to respond. Please try again.';
  }
  if (text.includes('network is unreachable') || text.includes('connection reset') || text.includes('econnreset') || text.includes('enotfound')) {
    return 'The source could not be reached from the downloader server. Please try again.';
  }
  if (text.includes('queue_full') || text.includes('download queue is full')) {
    return 'The downloader is busy right now. Please wait a moment and try again.';
  }
  return raw || 'The downloader could not complete the request.';
}

module.exports = {
  QUALITY_FORMATS,
  QUALITY_LIMITS,
  videoFormatFor,
  selectCompletedOutput,
  cleanupJobFiles,
  normalizeDownloadError,
};
