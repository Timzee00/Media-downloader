const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const dns = require('dns').promises;
const crypto = require('crypto');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const DATA_DIR = fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data');
const DOWNLOAD_DIR = path.join(DATA_DIR, 'downloads');
const DB_FILE = path.join(DATA_DIR, 'jobs.json');
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, '[]');

let writeChain = Promise.resolve();
function readJobs() { try { const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); return Array.isArray(parsed) ? parsed : []; } catch { return []; } }
function withJobs(mutator) { writeChain = writeChain.then(() => { const jobs = readJobs(); const result = mutator(jobs); fs.writeFileSync(DB_FILE, JSON.stringify(jobs, null, 2)); return result; }); return writeChain; }
function upsertJob(job) { return withJobs(jobs => { const index = jobs.findIndex(item => item.id === job.id); if (index >= 0) jobs[index] = job; else jobs.unshift(job); }); }
function getJob(id) { return readJobs().find(job => job.id === id); }

// ---------- Authentication ----------
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || '';
const SESSION_TOKEN = ACCESS_PASSWORD ? crypto.randomBytes(32).toString('hex') : null;
function requireAuth(req, res, next) { if (!ACCESS_PASSWORD) return next(); if (req.cookies?.session === SESSION_TOKEN) return next(); return res.status(401).json({ error: 'Not authenticated.' }); }
app.post('/api/login', (req, res) => { if (!ACCESS_PASSWORD) return res.json({ ok: true, authRequired: false }); const { password } = req.body || {}; if (password === ACCESS_PASSWORD) { res.cookie('session', SESSION_TOKEN, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000 }); return res.json({ ok: true }); } return res.status(401).json({ error: 'Wrong password.' }); });
app.get('/api/me', (req, res) => { if (!ACCESS_PASSWORD) return res.json({ authRequired: false, authenticated: true }); res.json({ authRequired: true, authenticated: req.cookies?.session === SESSION_TOKEN }); });

// ---------- URL validation / SSRF protection ----------
function isPrivateIp(ip) { if (ip.includes(':')) return ip === '::1' || ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd'); const [a, b] = ip.split('.').map(Number); return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0; }
async function isSafeUrl(value) { let url; try { url = new URL(value); } catch { return false; } if (!['http:', 'https:'].includes(url.protocol)) return false; try { const addresses = await dns.lookup(url.hostname, { all: true }); return addresses.every(({ address }) => !isPrivateIp(address)); } catch { return false; } }

// ---------- yt-dlp ----------
function runYtDlp(args) { return new Promise((resolve, reject) => { const proc = spawn('yt-dlp', args); let stdout = ''; let stderr = ''; proc.stdout.on('data', data => { stdout += data.toString(); }); proc.stderr.on('data', data => { stderr += data.toString(); }); proc.on('close', code => { if (code === 0) return resolve({ stdout, stderr }); reject(new Error(stderr || `yt-dlp exited with code ${code}`)); }); proc.on('error', reject); }); }

// ---------- TikTok photo/slideshow support ----------
// Short TikTok links can redirect to /video/<id> OR /photo/<id>.
// We inspect the final URL first so photo posts never fall through to yt-dlp.
function isTikTokHost(hostname) { const host = String(hostname || '').toLowerCase(); return host === 'tiktok.com' || host.endsWith('.tiktok.com'); }
function isTikTokPhotoPath(url) { try { const parsed = new URL(url); return isTikTokHost(parsed.hostname) && /^\/photo\/\d+/.test(parsed.pathname); } catch { return false; } }

function extractScriptJson(html, scriptId) {
  const exactMarker = `<script id="${scriptId}"`;
  let start = html.indexOf(exactMarker);
  if (start < 0) {
    const idNeedle = `id="${scriptId}"`;
    const idIndex = html.indexOf(idNeedle);
    if (idIndex < 0) return null;
    start = html.lastIndexOf('<script', idIndex);
    if (start < 0) return null;
  }
  const tagEnd = html.indexOf('>', start);
  if (tagEnd < 0) return null;
  const end = html.indexOf('</script>', tagEnd);
  if (end < 0) return null;
  const raw = html.slice(tagEnd + 1, end).trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { const objectStart = raw.indexOf('{'); const objectEnd = raw.lastIndexOf('}'); if (objectStart >= 0 && objectEnd > objectStart) { try { return JSON.parse(raw.slice(objectStart, objectEnd + 1)); } catch {} } return null; }
}

function findObjectByKey(root, key) { const seen = new Set(); function walk(value) { if (!value || typeof value !== 'object' || seen.has(value)) return null; seen.add(value); if (Object.prototype.hasOwnProperty.call(value, key)) return value[key]; for (const child of Object.values(value)) { const found = walk(child); if (found !== null && found !== undefined) return found; } return null; } return walk(root); }
function findTikTokItem(root, postId) { const seen = new Set(); function walk(value) { if (!value || typeof value !== 'object' || seen.has(value)) return null; seen.add(value); if ((String(value.id || '') === String(postId) || String(value.awemeId || '') === String(postId)) && (value.imagePost || value.video)) return value; for (const child of Object.values(value)) { const found = walk(child); if (found) return found; } return null; } return walk(root); }
function getTikTokItemFromData(data, postId) { if (!data) return null; const defaultScope = data.__DEFAULT_SCOPE__; const detail = defaultScope?.['webapp.video-detail']; const directItem = detail?.itemInfo?.itemStruct; if (directItem) return directItem; return findTikTokItem(data, postId) || findTikTokItem(findObjectByKey(data, 'itemStruct'), postId); }
function extractTikTokPageData(html, postId) { const datasets = [extractScriptJson(html, '__UNIVERSAL_DATA_FOR_REHYDRATION__'), extractScriptJson(html, 'SIGI_STATE'), extractScriptJson(html, '__NEXT_DATA__')].filter(Boolean); for (const data of datasets) { const item = getTikTokItemFromData(data, postId); if (item) return item; } return null; }
function collectTikTokImageUrls(item) { const images = item?.imagePost?.images || item?.imagePost?.imageList || []; const urls = []; const seen = new Set(); for (const image of images) { const candidates = image?.imageURL?.urlList || image?.urlList || image?.urls || []; for (const candidate of candidates) { if (typeof candidate !== 'string') continue; try { const parsed = new URL(candidate); const host = parsed.hostname.toLowerCase(); if (!['http:', 'https:'].includes(parsed.protocol)) continue; if (!(host === 'tiktokcdn.com' || host.endsWith('.tiktokcdn.com') || host.endsWith('.tiktokcdn-us.com') || host.endsWith('.tiktokcdn-eu.com'))) continue; if (!seen.has(candidate)) { seen.add(candidate); urls.push(candidate); } } catch {} if (urls.length >= 35) break; } if (urls.length >= 35) break; } return urls; }

const TIKTOK_HEADERS = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36', Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', 'Cache-Control': 'no-cache', Pragma: 'no-cache' };
async function fetchTikTokPage(url) { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 30000); try { const response = await fetch(url, { redirect: 'follow', signal: controller.signal, headers: TIKTOK_HEADERS }); if (!response.ok) throw new Error(`TikTok returned HTTP ${response.status}.`); return { finalUrl: response.url || url, html: await response.text() }; } finally { clearTimeout(timer); } }

async function resolveTikTokPhoto(url) {
  const { finalUrl, html } = await fetchTikTokPage(url);
  if (!isTikTokPhotoPath(finalUrl)) return null;
  const final = new URL(finalUrl);
  const match = final.pathname.match(/^\/photo\/(\d+)/);
  if (!match) throw new Error('Could not determine the TikTok photo post ID.');
  const postId = match[1];
  const item = extractTikTokPageData(html, postId);
  if (!item) throw new Error('TikTok loaded the photo page but did not expose its image data to the downloader.');
  const imageUrls = collectTikTokImageUrls(item);
  if (!imageUrls.length) throw new Error('This TikTok photo post contains no downloadable images.');
  return { postId, finalUrl, title: item.imagePost?.title || item.desc || 'TikTok photo slideshow', thumbnail: imageUrls[0], uploader: item.author?.nickname || item.author?.uniqueId || null, imageUrls };
}

async function tryResolveTikTokPhoto(url) {
  try {
    return await resolveTikTokPhoto(url);
  } catch (error) {
    // If the short link resolves to a photo page, do not silently hand it to yt-dlp.
    try {
      const { finalUrl } = await fetchTikTokPage(url);
      if (isTikTokPhotoPath(finalUrl)) throw error;
    } catch (secondError) {
      if (isTikTokPhotoPath(url)) throw error;
    }
    return null;
  }
}

async function downloadTikTokAsset(url, destination, referer) { const response = await fetch(url, { redirect: 'follow', headers: { ...TIKTOK_HEADERS, Referer: referer, Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8' } }); if (!response.ok) throw new Error(`TikTok image server returned HTTP ${response.status}.`); const maxImageBytes = 20 * 1024 * 1024; const contentLength = Number(response.headers.get('content-length') || 0); if (contentLength > maxImageBytes) throw new Error('A TikTok image exceeded the 20 MB safety limit.'); const buffer = Buffer.from(await response.arrayBuffer()); if (buffer.length > maxImageBytes) throw new Error('A TikTok image exceeded the 20 MB safety limit.'); fs.writeFileSync(destination, buffer); }
function createZipArchive(files, zipPath) { return new Promise((resolve, reject) => { const script = ['import sys, zipfile, os','out = sys.argv[1]','files = sys.argv[2:]','with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:','    for f in files:','        z.write(f, os.path.basename(f))'].join('\n'); const proc = spawn('python3', ['-c', script, zipPath, ...files]); let stderr = ''; proc.stderr.on('data', data => { stderr += data.toString(); }); proc.on('close', code => code === 0 ? resolve() : reject(new Error(stderr || 'Could not create the photo archive.'))); proc.on('error', reject); }); }
async function processTikTokPhotoJob(job, id, photo) { const imageFiles = []; const prefix = path.join(DOWNLOAD_DIR, `${id}-photo-`); try { for (let index = 0; index < photo.imageUrls.length; index++) { const assetUrl = photo.imageUrls[index]; let extension = 'jpg'; try { const pathname = new URL(assetUrl).pathname.toLowerCase(); if (pathname.endsWith('.png')) extension = 'png'; else if (pathname.endsWith('.webp')) extension = 'webp'; else if (pathname.endsWith('.heic')) extension = 'heic'; } catch {} const filePath = `${prefix}${String(index + 1).padStart(2, '0')}.${extension}`; await downloadTikTokAsset(assetUrl, filePath, photo.finalUrl); imageFiles.push(filePath); } if (!imageFiles.length) throw new Error('No images were downloaded from the TikTok post.'); const zipPath = path.join(DOWNLOAD_DIR, `${id}-tiktok-photos.zip`); await createZipArchive(imageFiles, zipPath); for (const file of imageFiles) { try { fs.unlinkSync(file); } catch {} } return { title: photo.title, thumbnail: photo.thumbnail, duration: null, sourcePlatform: 'TikTok Photo', filePath: path.basename(zipPath), fileSize: fs.statSync(zipPath).size, imageCount: imageFiles.length }; } catch (error) { for (const file of imageFiles) { try { fs.unlinkSync(file); } catch {} } throw error; } }

// ---------- Rate limiting ----------
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000, RATE_LIMIT_MAX = 15, MAX_CONCURRENT_JOBS = 2;
const rateBuckets = new Map(); let activeJobCount = 0;
function rateLimit(req, res, next) { const ip = req.ip || req.connection.remoteAddress || 'unknown', now = Date.now(); const bucket = (rateBuckets.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS); if (bucket.length >= RATE_LIMIT_MAX) return res.status(429).json({ error: 'Too many requests — please slow down and try again shortly.' }); bucket.push(now); rateBuckets.set(ip, bucket); next(); }
function truncate(str, max = 500) { if (!str) return str; return str.length > max ? str.slice(0, max) + '... (truncated)' : str; }

// ---------- Metadata ----------
app.post('/api/info', requireAuth, rateLimit, async (req, res) => {
  const { url } = req.body || {};
  if (!url || !(await isSafeUrl(url))) return res.status(400).json({ error: 'A valid, public http(s) URL is required.' });
  try {
    const photo = await tryResolveTikTokPhoto(url);
    if (photo) return res.json({ title: photo.title, thumbnail: photo.thumbnail, duration: null, uploader: photo.uploader, extractor: 'TikTok Photo', contentType: 'photo', imageCount: photo.imageUrls.length, availableHeights: [] });
    const { stdout } = await runYtDlp(['-j', '--no-playlist', url]);
    const info = JSON.parse(stdout.trim().split('\n')[0]);
    return res.json({ title: info.title, thumbnail: info.thumbnail, duration: info.duration, uploader: info.uploader, extractor: info.extractor, contentType: 'video', availableHeights: [...new Set((info.formats || []).map(format => format.height).filter(Boolean))].sort((a, b) => b - a) });
  } catch (error) { return res.status(422).json({ error: 'Could not read that link.', detail: truncate(error.message) }); }
});

const QUALITY_FORMATS = { best: 'bestvideo+bestaudio/best', '2160p': 'bestvideo[height<=2160]+bestaudio/best[height<=2160]', '1440p': 'bestvideo[height<=1440]+bestaudio/best[height<=1440]', '1080p': 'bestvideo[height<=1080]+bestaudio/best[height<=1080]', '720p': 'bestvideo[height<=720]+bestaudio/best[height<=720]', '480p': 'bestvideo[height<=480]+bestaudio/best[height<=480]', '360p': 'bestvideo[height<=360]+bestaudio/best[height<=360]' };

// ---------- Download ----------
app.post('/api/download', requireAuth, rateLimit, async (req, res) => {
  const { url, quality = 'best', type = 'video' } = req.body || {};
  if (!url || !(await isSafeUrl(url))) return res.status(400).json({ error: 'A valid, public http(s) URL is required.' });
  if (!['video', 'audio'].includes(type)) return res.status(400).json({ error: "type must be 'video' or 'audio'." });
  if (activeJobCount >= MAX_CONCURRENT_JOBS) return res.status(429).json({ error: 'Server is busy processing other downloads — please try again in a moment.' });
  const id = uuidv4();
  const job = { id, url, quality, type, status: 'processing', title: null, thumbnail: null, filePath: null, fileSize: null, error: null, createdAt: new Date().toISOString() };
  await upsertJob(job);
  res.json({ jobId: id });
  activeJobCount++;
  processJob(id).catch(async error => { const current = getJob(id); if (!current) return; current.status = 'failed'; current.error = truncate(error.message); await upsertJob(current); }).finally(() => { activeJobCount--; });
});

async function processJob(id) {
  const job = getJob(id); if (!job) return;
  const photo = await tryResolveTikTokPhoto(job.url);
  if (photo) {
    if (job.type === 'audio') throw new Error('TikTok photo posts contain images, so audio-only download is not available.');
    const result = await processTikTokPhotoJob(job, id, photo);
    const updated = getJob(id);
    Object.assign(updated, result, { status: 'done', type: 'photo' });
    await upsertJob(updated);
    return;
  }

  let info = {};
  try { const { stdout } = await runYtDlp(['-j', '--no-playlist', job.url]); info = JSON.parse(stdout.trim().split('\n')[0]); } catch {}
  const outputTemplate = path.join(DOWNLOAD_DIR, `${id}.%(ext)s`);
  let args;
  if (job.type === 'audio') {
    args = ['-x', '--audio-format', 'mp3', '--audio-quality', '0', '--no-playlist', '-o', outputTemplate, job.url];
  } else {
    const format = QUALITY_FORMATS[job.quality] || QUALITY_FORMATS.best;
    args = ['-f', format, '--merge-output-format', 'mp4', '--no-playlist', '-o', outputTemplate, job.url];
  }
  await runYtDlp(args);
  const files = fs.readdirSync(DOWNLOAD_DIR).filter(file => file.startsWith(id));
  if (!files.length) throw new Error('Download finished but no output file was found.');
  const finalFile = files[0];
  const fullPath = path.join(DOWNLOAD_DIR, finalFile);
  const updated = getJob(id);
  updated.status = 'done';
  updated.title = info.title || 'Untitled';
  updated.thumbnail = info.thumbnail || null;
  updated.duration = info.duration || null;
  updated.sourcePlatform = info.extractor || null;
  updated.filePath = finalFile;
  updated.fileSize = fs.statSync(fullPath).size;
  await upsertJob(updated);
}

// ---------- Job/history ----------
app.get('/api/status/:id', requireAuth, (req, res) => { const job = getJob(req.params.id); if (!job) return res.status(404).json({ error: 'Job not found.' }); res.json(job); });
app.get('/api/history', requireAuth, (req, res) => { res.json(readJobs().filter(job => job.status === 'done')); });
app.delete('/api/history/:id', requireAuth, async (req, res) => { const jobs = readJobs(); const job = jobs.find(item => item.id === req.params.id); if (job?.filePath) { const fullPath = path.join(DOWNLOAD_DIR, job.filePath); if (fs.existsSync(fullPath)) { try { fs.unlinkSync(fullPath); } catch {} } } await withJobs(list => { const index = list.findIndex(item => item.id === req.params.id); if (index >= 0) list.splice(index, 1); }); res.json({ success: true }); });
app.get('/files/:id', requireAuth, (req, res) => { const job = getJob(req.params.id); if (!job || job.status !== 'done' || !job.filePath) return res.status(404).json({ error: 'File not available.' }); const fullPath = path.join(DOWNLOAD_DIR, job.filePath); if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'File missing on disk.' }); res.download(fullPath, job.filePath); });
app.get('/health', (req, res) => res.json({ ok: true }));

// ---------- Cleanup ----------
const MAX_AGE_HOURS = Number(process.env.MAX_AGE_HOURS || 24);
async function cleanupOldFiles() { const cutoff = Date.now() - MAX_AGE_HOURS * 60 * 60 * 1000; await withJobs(jobs => { const keep = []; for (const job of jobs) { const age = new Date(job.createdAt).getTime(); const expired = age < cutoff && job.status === 'done'; if (expired && job.filePath) { const fullPath = path.join(DOWNLOAD_DIR, job.filePath); if (fs.existsSync(fullPath)) { try { fs.unlinkSync(fullPath); } catch {} } } if (!expired) keep.push(job); } jobs.length = 0; jobs.push(...keep); }); }
setInterval(() => cleanupOldFiles().catch(() => {}), 60 * 60 * 1000);

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => { console.log(`Downloader service running on port ${PORT}`); if (!ACCESS_PASSWORD) console.warn('WARNING: ACCESS_PASSWORD is not set — this service is open to anyone with the URL.'); });
