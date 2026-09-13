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
app.use(cors());
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const DATA_DIR = fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data');
const DOWNLOAD_DIR = path.join(DATA_DIR, 'downloads');
const DB_FILE = path.join(DATA_DIR, 'jobs.json');
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, '[]');

let writeChain = Promise.resolve();
function readJobs() { try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return []; } }
function withJobs(mutator) { writeChain = writeChain.then(() => { const jobs = readJobs(); const result = mutator(jobs); fs.writeFileSync(DB_FILE, JSON.stringify(jobs, null, 2)); return result; }); return writeChain; }
function upsertJob(job) { return withJobs(jobs => { const idx = jobs.findIndex(j => j.id === job.id); if (idx >= 0) jobs[idx] = job; else jobs.unshift(job); }); }
function getJob(id) { return readJobs().find(j => j.id === id); }

const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || '';
const SESSION_TOKEN = ACCESS_PASSWORD ? crypto.randomBytes(32).toString('hex') : null;
function requireAuth(req, res, next) { if (!ACCESS_PASSWORD) return next(); if (req.cookies && req.cookies.session === SESSION_TOKEN) return next(); return res.status(401).json({ error: 'Not authenticated.' }); }

app.post('/api/login', (req, res) => {
  if (!ACCESS_PASSWORD) return res.json({ ok: true, authRequired: false });
  const { password } = req.body || {};
  if (password === ACCESS_PASSWORD) { res.cookie('session', SESSION_TOKEN, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000 }); return res.json({ ok: true }); }
  res.status(401).json({ error: 'Wrong password.' });
});
app.get('/api/me', (req, res) => { if (!ACCESS_PASSWORD) return res.json({ authRequired: false, authenticated: true }); res.json({ authRequired: true, authenticated: req.cookies && req.cookies.session === SESSION_TOKEN }); });

function isPrivateIp(ip) {
  if (ip.includes(':')) return ip === '::1' || ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd');
  const [a, b] = ip.split('.').map(Number);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0;
}
async function isSafeUrl(url) {
  let u; try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  try { const { address } = await dns.lookup(u.hostname); return !isPrivateIp(address); } catch { return false; }
}

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', args); let stdout = ''; let stderr = '';
    proc.stdout.on('data', d => (stdout += d.toString())); proc.stderr.on('data', d => (stderr += d.toString()));
    proc.on('close', code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr || `yt-dlp exited with code ${code}`)));
    proc.on('error', reject);
  });
}

function isTikTokHost(hostname) { const host = hostname.toLowerCase(); return host === 'tiktok.com' || host.endsWith('.tiktok.com'); }
function isTikTokShortUrl(url) {
  try { const u = new URL(url); return isTikTokHost(u.hostname) && (u.hostname.startsWith('vt.') || u.hostname.startsWith('vm.') || u.pathname.startsWith('/t/')); } catch { return false; }
}
function isTikTokPhotoUrl(url) {
  try { const u = new URL(url); return isTikTokHost(u.hostname) && /\/photo\/\d+/.test(u.pathname); } catch { return false; }
}

function extractJsonScript(html, id) {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<script[^>]*id=["']${escapedId}["'][^>]*>([\\s\\S]*?)<\\/script>`, 'i');
  const match = html.match(re); if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}
function findTikTokItem(root, postId) {
  const seen = new Set();
  function walk(value) {
    if (!value || typeof value !== 'object' || seen.has(value)) return null; seen.add(value);
    if ((value.id && String(value.id) === String(postId) || value.awemeId && String(value.awemeId) === String(postId)) && (value.imagePost || value.video)) return value;
    for (const child of Object.values(value)) { const found = walk(child); if (found) return found; }
    return null;
  }
  return walk(root);
}
function collectTikTokImageUrls(item) {
  const urls = [], seen = new Set(); const images = item?.imagePost?.images || item?.imagePost?.imageList || [];
  for (const image of images) {
    const candidates = image?.imageURL?.urlList || image?.urlList || image?.urls || [];
    for (const candidate of candidates) {
      if (typeof candidate !== 'string') continue;
      try {
        const u = new URL(candidate), host = u.hostname.toLowerCase();
        if (!['http:', 'https:'].includes(u.protocol)) continue;
        if (!(host === 'tiktokcdn.com' || host.endsWith('.tiktokcdn.com') || host.endsWith('.tiktokcdn-us.com') || host.endsWith('.tiktokcdn-eu.com'))) continue;
        if (!seen.has(candidate)) { seen.add(candidate); urls.push(candidate); }
      } catch {}
      if (urls.length >= 35) return urls;
      break;
    }
  }
  return urls;
}

async function resolveTikTokPhoto(url) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, { redirect: 'follow', signal: controller.signal, headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9'
    }});
    if (!response.ok) throw new Error(`TikTok returned HTTP ${response.status}.`);
    const finalUrl = response.url || url; const final = new URL(finalUrl); const match = final.pathname.match(/\/(?:photo|video)\/(\d+)/);
    if (!match) throw new Error('Could not determine the TikTok post ID.');
    const postId = match[1]; const html = await response.text();
    const datasets = [extractJsonScript(html, '__UNIVERSAL_DATA_FOR_REHYDRATION__'), extractJsonScript(html, 'SIGI_STATE'), extractJsonScript(html, '__NEXT_DATA__')].filter(Boolean);
    let item = null; for (const data of datasets) { item = findTikTokItem(data, postId); if (item) break; }
    if (!item) throw new Error('TikTok did not expose the post data to this server.');
    const imageUrls = collectTikTokImageUrls(item);
    if (!imageUrls.length) throw new Error('This TikTok post is not a downloadable photo slideshow.');
    return { postId, finalUrl, title: item.desc || item.imagePost?.title || 'TikTok photo slideshow', thumbnail: imageUrls[0], uploader: item.author?.nickname || item.author?.uniqueId || null, imageUrls, duration: null };
  } finally { clearTimeout(timer); }
}
async function tryResolveTikTokPhoto(url) {
  if (!isTikTokPhotoUrl(url) && !isTikTokShortUrl(url)) return null;
  try { return await resolveTikTokPhoto(url); } catch (err) { if (isTikTokPhotoUrl(url)) throw err; return null; }
}

async function downloadTikTokAsset(url, destination, referer) {
  const response = await fetch(url, { redirect: 'follow', headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36', Referer: referer,
    Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
  }});
  if (!response.ok) throw new Error(`TikTok image server returned HTTP ${response.status}.`);
  const contentLength = Number(response.headers.get('content-length') || 0); if (contentLength > 20 * 1024 * 1024) throw new Error('A TikTok image was larger than the 20 MB safety limit.');
  const buffer = Buffer.from(await response.arrayBuffer()); if (buffer.length > 20 * 1024 * 1024) throw new Error('A TikTok image was larger than the 20 MB safety limit.');
  fs.writeFileSync(destination, buffer); return buffer.length;
}
function createZipArchive(files, zipPath) {
  return new Promise((resolve, reject) => {
    const script = ['import sys, zipfile, os','out = sys.argv[1]','files = sys.argv[2:]','with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:','    for f in files: z.write(f, os.path.basename(f))'].join('\n');
    const proc = spawn('python3', ['-c', script, zipPath, ...files]); let stderr = ''; proc.stderr.on('data', d => (stderr += d.toString()));
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(stderr || 'Could not create the photo archive.'))); proc.on('error', reject);
  });
}
async function processTikTokPhotoJob(job, id, photo = null) {
  photo = photo || await resolveTikTokPhoto(job.url); const prefix = path.join(DOWNLOAD_DIR, `${id}-photo-`); const imageFiles = [];
  try {
    for (let i = 0; i < photo.imageUrls.length; i++) {
      const assetUrl = photo.imageUrls[i]; let ext = 'jpg';
      try { const pathname = new URL(assetUrl).pathname.toLowerCase(); if (pathname.endsWith('.png')) ext = 'png'; else if (pathname.endsWith('.webp')) ext = 'webp'; else if (pathname.endsWith('.heic')) ext = 'heic'; } catch {}
      const filePath = `${prefix}${String(i + 1).padStart(2, '0')}.${ext}`; await downloadTikTokAsset(assetUrl, filePath, photo.finalUrl); imageFiles.push(filePath);
    }
    const zipPath = path.join(DOWNLOAD_DIR, `${id}-tiktok-photos.zip`); await createZipArchive(imageFiles, zipPath);
    for (const file of imageFiles) { try { fs.unlinkSync(file); } catch {} }
    return { title: photo.title, thumbnail: photo.thumbnail, duration: null, sourcePlatform: 'TikTok Photo', filePath: path.basename(zipPath), fileSize: fs.statSync(zipPath).size, imageCount: imageFiles.length };
  } catch (err) { for (const file of imageFiles) { try { fs.unlinkSync(file); } catch {} } throw err; }
}

const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000, RATE_LIMIT_MAX = 15, MAX_CONCURRENT_JOBS = 2;
const rateBuckets = new Map(); let activeJobCount = 0;
function rateLimit(req, res, next) { const ip = req.ip || req.connection.remoteAddress || 'unknown', now = Date.now(); const bucket = (rateBuckets.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS); if (bucket.length >= RATE_LIMIT_MAX) return res.status(429).json({ error: 'Too many requests — please slow down and try again shortly.' }); bucket.push(now); rateBuckets.set(ip, bucket); next(); }
function truncate(str, max = 500) { if (!str) return str; return str.length > max ? str.slice(0, max) + '... (truncated)' : str; }

app.post('/api/info', requireAuth, rateLimit, async (req, res) => {
  const { url } = req.body || {}; if (!url || !(await isSafeUrl(url))) return res.status(400).json({ error: 'A valid, public http(s) URL is required.' });
  try {
    const photo = await tryResolveTikTokPhoto(url);
    if (photo) return res.json({ title: photo.title, thumbnail: photo.thumbnail, duration: null, uploader: photo.uploader, extractor: 'TikTok Photo', contentType: 'photo', imageCount: photo.imageUrls.length, availableHeights: [] });
    const { stdout } = await runYtDlp(['-j', '--no-playlist', url]); const info = JSON.parse(stdout.trim().split('\n')[0]);
    res.json({ title: info.title, thumbnail: info.thumbnail, duration: info.duration, uploader: info.uploader, extractor: info.extractor, contentType: 'video', availableHeights: [...new Set((info.formats || []).map(f => f.height).filter(Boolean))].sort((a, b) => b - a) });
  } catch (err) { res.status(422).json({ error: 'Could not read that link.', detail: truncate(err.message) }); }
});

const QUALITY_FORMATS = { best:'bestvideo+bestaudio/best','2160p':'bestvideo[height<=2160]+bestaudio/best[height<=2160]','1440p':'bestvideo[height<=1440]+bestaudio/best[height<=1440]','1080p':'bestvideo[height<=1080]+bestaudio/best[height<=1080]','720p':'bestvideo[height<=720]+bestaudio/best[height<=720]','480p':'bestvideo[height<=480]+bestaudio/best[height<=480]','360p':'bestvideo[height<=360]+bestaudio/best[height<=360]' };

app.post('/api/download', requireAuth, rateLimit, async (req, res) => {
  const { url, quality = 'best', type = 'video' } = req.body || {};
  if (!url || !(await isSafeUrl(url))) return res.status(400).json({ error: 'A valid, public http(s) URL is required.' });
  if (!['video','audio'].includes(type)) return res.status(400).json({ error: "type must be 'video' or 'audio'." });
  if (activeJobCount >= MAX_CONCURRENT_JOBS) return res.status(429).json({ error: 'Server is busy processing other downloads — please try again in a moment.' });
  const id = uuidv4(), job = { id, url, quality, type, status:'processing', title:null, thumbnail:null, filePath:null, fileSize:null, error:null, createdAt:new Date().toISOString() };
  await upsertJob(job); res.json({ jobId:id }); activeJobCount++;
  processJob(id).catch(async err => { const j=getJob(id); if(j){j.status='failed';j.error=truncate(err.message);await upsertJob(j);} }).finally(()=>{activeJobCount--;});
});

async function processJob(id) {
  const job = getJob(id); if (!job) return;
  const photo = await tryResolveTikTokPhoto(job.url);
  if (photo) {
    if (job.type === 'audio') throw new Error('TikTok photo posts contain images, so audio-only download is not available.');
    const result = await processTikTokPhotoJob(job, id, photo); const updated = getJob(id); Object.assign(updated, result, { status:'done', type:'photo' }); await upsertJob(updated); return;
  }

  let info = {}; try { const { stdout } = await runYtDlp(['-j','--no-playlist',job.url]); info = JSON.parse(stdout.trim().split('\n')[0]); } catch {}
  const outputTemplate = path.join(DOWNLOAD_DIR, `${id}.%(ext)s`); let args;
  if (job.type === 'audio') args = ['-x','--audio-format','mp3','--audio-quality','0','--no-playlist','-o',outputTemplate,job.url];
  else { const format=QUALITY_FORMATS[job.quality]||QUALITY_FORMATS.best; args=['-f',format,'--merge-output-format','mp4','--no-playlist','-o',outputTemplate,job.url]; }
  await runYtDlp(args);
  const files=fs.readdirSync(DOWNLOAD_DIR).filter(f=>f.startsWith(id)); if(!files.length) throw new Error('Download finished but no output file was found.');
  const finalFile=files[0], fullPath=path.join(DOWNLOAD_DIR,finalFile), updated=getJob(id); updated.status='done'; updated.title=info.title||'Untitled'; updated.thumbnail=info.thumbnail||null; updated.duration=info.duration||null; updated.sourcePlatform=info.extractor||null; updated.filePath=finalFile; updated.fileSize=fs.statSync(fullPath).size; await upsertJob(updated);
}

app.get('/api/status/:id', requireAuth, (req,res)=>{const job=getJob(req.params.id);if(!job)return res.status(404).json({error:'Job not found.'});res.json(job);});
app.get('/api/history', requireAuth, (req,res)=>res.json(readJobs().filter(j=>j.status==='done')));
app.delete('/api/history/:id', requireAuth, async (req,res)=>{const jobs=readJobs(),job=jobs.find(j=>j.id===req.params.id);if(job&&job.filePath){const fullPath=path.join(DOWNLOAD_DIR,job.filePath);if(fs.existsSync(fullPath))fs.unlinkSync(fullPath);}await withJobs(list=>{const idx=list.findIndex(j=>j.id===req.params.id);if(idx>=0)list.splice(idx,1);});res.json({success:true});});
app.get('/files/:id', requireAuth, (req,res)=>{const job=getJob(req.params.id);if(!job||job.status!=='done'||!job.filePath)return res.status(404).json({error:'File not available.'});const fullPath=path.join(DOWNLOAD_DIR,job.filePath);if(!fs.existsSync(fullPath))return res.status(404).json({error:'File missing on disk.'});res.download(fullPath,job.filePath);});
app.get('/health',(req,res)=>res.json({ok:true}));

const MAX_AGE_HOURS=Number(process.env.MAX_AGE_HOURS||24);
async function cleanupOldFiles(){const cutoff=Date.now()-MAX_AGE_HOURS*60*60*1000;await withJobs(jobs=>{const keep=[];for(const job of jobs){const age=new Date(job.createdAt).getTime(),expired=age<cutoff&&job.status==='done';if(expired&&job.filePath){const fullPath=path.join(DOWNLOAD_DIR,job.filePath);if(fs.existsSync(fullPath)){try{fs.unlinkSync(fullPath);}catch{}}}if(!expired)keep.push(job);}jobs.length=0;jobs.push(...keep);});}
setInterval(()=>cleanupOldFiles().catch(()=>{}),60*60*1000);
const PORT=process.env.PORT||3000;
app.listen(PORT,()=>{console.log(`Downloader service running on port ${PORT}`);if(!ACCESS_PASSWORD)console.warn('WARNING: ACCESS_PASSWORD is not set — this service is open to anyone with the URL.');});
