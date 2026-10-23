'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const PROGRESS_PREFIX = 'TIMZEE_PROGRESS|';
function progressArgs() {
  return ['--newline', '--progress', '--progress-delta', '1', '--progress-template',
    `download:${PROGRESS_PREFIX}%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s`,
    '--print', 'after_move:filepath'];
}
function parseProgress(line) {
  const p = String(line).indexOf(PROGRESS_PREFIX);
  if (p < 0) return null;
  const fields = String(line).slice(p + PROGRESS_PREFIX.length).trim().split('|');
  if (fields.length < 5) return null;
  const num = value => { const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : null; };
  const downloadedBytes = num(fields[0]);
  const totalBytes = num(fields[1]) || num(fields[2]);
  const speedBytesPerSec = num(fields[3]);
  const etaSeconds = num(fields[4]);
  const percent = totalBytes && downloadedBytes !== null ? Math.max(0, Math.min(100, Math.round(100 * downloadedBytes / totalBytes))) : null;
  return { downloadedBytes, totalBytes, speedBytesPerSec, etaSeconds, percent };
}
function fallbackOutputName(template) {
  const name = path.basename(String(template || '')).replace(/\.\%\(ext\)s$/, '');
  if (!/^[a-zA-Z0-9_-]{8,120}$/.test(name)) throw new Error('Invalid downloader output template.');
  return `${name}-fallback`;
}
const temp = /\.(part|ytdl|download|tmp|temp|frag|aria2|info\.json)$/i;
const audioExt = new Set(['.mp3', '.m4a', '.aac', '.opus', '.ogg', '.wav', '.webm', '.mp4', '.flac', '.wma']);
const videoExt = new Set(['.mp4', '.mkv', '.webm', '.mov', '.avi', '.flv', '.m4v', '.ts']);
function isJobFile(name, id) { return name === id || name.startsWith(`${id}.`) || name.startsWith(`${id}-`); }
function selectCandidate(dir, id, type, printedPath = null) {
  const listed = fs.readdirSync(dir).filter(n => isJobFile(n, id) && !temp.test(n));
  const found = listed.map(name => {
    const fullPath = path.join(dir, name);
    try {
      const st = fs.statSync(fullPath);
      const ext = path.extname(name).toLowerCase();
      const fallback = name === `${id}-fallback` || name.startsWith(`${id}-fallback.`);
      if (!st.isFile() || st.size <= 0 || !(fallback || (type === 'audio' ? audioExt : videoExt).has(ext))) return null;
      return { name, fullPath, size: st.size, mtimeMs: st.mtimeMs };
    } catch { return null; }
  }).filter(Boolean);
  let preferred = null;
  if (printedPath) {
    const target = path.resolve(String(printedPath).trim());
    preferred = found.find(f => path.resolve(f.fullPath) === target);
  }
  found.sort((a,b) => (b.name === `${id}.mp3` ? 1 : 0) - (a.name === `${id}.mp3` ? 1 : 0) || (b.mtimeMs - a.mtimeMs) || (b.size-a.size));
  return { selected: preferred || found[0] || null, artifacts: listed.slice(0, 12) };
}
function runMediaTool(command, args, timeoutMs = 600000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', settled = false;
    const timer = setTimeout(() => { proc.kill('SIGKILL'); finish(new Error(`${command} exceeded its processing timeout.`)); }, timeoutMs);
    function finish(err, value) { if (settled) return; settled = true; clearTimeout(timer); err ? reject(err) : resolve(value); }
    proc.stdout.on('data', x => { stdout = (stdout + x).slice(-512000); });
    proc.stderr.on('data', x => { stderr = (stderr + x).slice(-512000); });
    proc.on('error', e => finish(e));
    proc.on('close', code => code === 0 ? finish(null, stdout) : finish(new Error(`${command} failed (${code}): ${stderr.slice(-1200)}`)));
  });
}
async function probeMedia(file) {
  const output = await runMediaTool('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name:format=format_name,duration', '-of', 'json', file], 30000);
  let info;
  try { info = JSON.parse(output); } catch { throw new Error('The downloaded file could not be inspected.'); }
  return { audio: Boolean(info.streams?.some(s => s.codec_type === 'audio')), audioCodec: info.streams?.find(s => s.codec_type === 'audio')?.codec_name || null, video: Boolean(info.streams?.some(s => s.codec_type === 'video')), format: String(info.format?.format_name || ''), duration: Number(info.format?.duration) || null };
}
async function finalizeMedia({ dir, id, type, printedPath = null, maxBytes = 1024 * 1024 * 1024 }) {
  const { selected, artifacts } = selectCandidate(dir, id, type, printedPath);
  if (!selected) {
    const err = new Error('Downloader returned without a usable output file. Review engine logs.');
    err.code = 'NO_MEDIA_OUTPUT';
    err.artifacts = artifacts;
    throw err;
  }
  if (selected.size > maxBytes) throw new Error('Source media exceeds the configured file size limit.');
  const probe = await probeMedia(selected.fullPath);
  if (type === 'audio' && !probe.audio) throw new Error('The source did not contain a valid audio stream.');
  if (type === 'video' && !probe.video) throw new Error('The source did not contain a valid video stream.');
  let finalPath = selected.fullPath;
  if (type === 'audio' && (path.extname(selected.name).toLowerCase() !== '.mp3' || probe.audioCodec !== 'mp3')) {
    const mp3 = path.join(dir, `${id}.mp3`);
    const output = finalPath === mp3 ? path.join(dir, `${id}-converted.mp3`) : mp3;
    await runMediaTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', finalPath,
      '-vn', '-map', '0:a:0', '-map_metadata', '0', '-c:a', 'libmp3lame', '-q:a', '2', '-id3v2_version', '3', output]);
    const verified = await probeMedia(output);
    if (!verified.audio || verified.audioCodec !== 'mp3') throw new Error('MP3 conversion produced no playable MP3 stream.');
    fs.unlinkSync(finalPath);
    if (output !== mp3) fs.renameSync(output, mp3);
    finalPath = mp3;
  } else if (type === 'video' && !videoExt.has(path.extname(selected.name).toLowerCase())) {
    const extension = probe.format.includes('webm') ? '.webm' : probe.format.includes('mp4') || probe.format.includes('mov') ? '.mp4' : '.mkv';
    const target = path.join(dir, `${id}${extension}`);
    fs.renameSync(finalPath, target);
    finalPath = target;
  }
  const stat = fs.statSync(finalPath);
  if (stat.size <= 0 || stat.size > maxBytes) throw new Error('Completed file has an invalid size.');
  return { filePath: path.basename(finalPath), fileSize: stat.size, duration: probe.duration };
}
module.exports = { progressArgs, parseProgress, fallbackOutputName, selectCandidate, runMediaTool, probeMedia, finalizeMedia };
