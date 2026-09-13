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

// ---- Storage setup ----
const DATA_DIR = fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data');
const DOWNLOAD_DIR = path.join(DATA_DIR, 'downloads');
const DB_FILE = path.join(DATA_DIR, 'jobs.json');

fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, '[]');

// ---- Simple write queue so concurrent jobs can't clobber jobs.json ----
let writeChain = Promise.resolve();
function readJobs() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return [];
  }
}
function withJobs(mutator) {
  // Chains every read-modify-write onto the same promise so they run one at a time.
  writeChain = writeChain.then(() => {
    const jobs = readJobs();
    const result = mutator(jobs);
    fs.writeFileSync(DB_FILE, JSON.stringify(jobs, null, 2));
    return result;
  });
  return writeChain;
}
function upsertJob(job) {
  return withJobs(jobs => {
    const idx = jobs.findIndex(j => j.id === job.id);
    if (idx >= 0) jobs[idx] = job;
    else jobs.unshift(job);
  });
}
function getJob(id) {
  return readJobs().find(j => j.id === id);
}

// ---- Auth (single shared password — this is a personal tool, not multi-user) ----
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || '';
const SESSION_TOKEN = ACCESS_PASSWORD ? crypto.randomBytes(32).toString('hex') : null;

function requireAuth(req, res, next) {
  if (!ACCESS_PASSWORD) return next(); // auth disabled if no password is set
  if (req.cookies && req.cookies.session === SESSION_TOKEN) return next();
  return res.status(401).json({ error: 'Not authenticated.' });
}

app.post('/api/login', (req, res) => {
  if (!ACCESS_PASSWORD) return res.json({ ok: true, authRequired: false });
  const { password } = req.body || {};
  if (password === ACCESS_PASSWORD) {
    res.cookie('session', SESSION_TOKEN, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    });
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Wrong password.' });
});

app.get('/api/me', (req, res) => {
  if (!ACCESS_PASSWORD) return res.json({ authRequired: false, authenticated: true });
  const authenticated = req.cookies && req.cookies.session === SESSION_TOKEN;
  res.json({ authRequired: true, authenticated });
});

// ---- URL validation + basic SSRF protection ----
// Blocks the server from being used to fetch its own internal network / cloud metadata endpoints.
function isPrivateIp(ip) {
  if (ip.includes(':')) {
    return ip === '::1' || ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd');
  }
  const parts = ip.split('.').map(Number);
  const [a, b] = parts;
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 0) return true;
  return false;
}

async function isSafeUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  try {
    const { address } = await dns.lookup(u.hostname);
    return !isPrivateIp(address);
  } catch {
    return false;
  }
}

// ---- yt-dlp helpers ----
function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', args);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => (stdout += d.toString()));
    proc.stderr.on('data', d => (stderr += d.toString()));
    proc.on('close', code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr || `yt-dlp exited with code ${code}`));
    });
    proc.on('error', reject);
  });
}

// ---- Rate limiting + concurrency cap (no extra dependency, kept simple) ----
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 15; // requests per window per IP, across /api/info + /api/download
const MAX_CONCURRENT_JOBS = 2;

const rateBuckets = new Map();
let activeJobCount = 0;

function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  const bucket = (rateBuckets.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  if (bucket.length >= RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Too many requests — please slow down and try again shortly.' });
  }
  bucket.push(now);
  rateBuckets.set(ip, bucket);
  next();
}

function truncate(str, max = 500) {
  if (!str) return str;
  return str.length > max ? str.slice(0, max) + '... (truncated)' : str;
}

app.post('/api/info', requireAuth, rateLimit, async (req, res) => {
  const { url } = req.body || {};
  if (!url || !(await isSafeUrl(url))) {
    return res.status(400).json({ error: 'A valid, public http(s) URL is required.' });
  }
  try {
    const { stdout } = await runYtDlp(['-j', '--no-playlist', url]);
    const info = JSON.parse(stdout.trim().split('\n')[0]);
    res.json({
      title: info.title,
      thumbnail: info.thumbnail,
      duration: info.duration,
      uploader: info.uploader,
      extractor: info.extractor,
      availableHeights: [...new Set(
        (info.formats || [])
          .map(f => f.height)
          .filter(Boolean)
      )].sort((a, b) => b - a),
    });
  } catch (err) {
    res.status(422).json({ error: 'Could not read that link.', detail: truncate(err.message) });
  }
});

const QUALITY_FORMATS = {
  best: 'bestvideo+bestaudio/best',
  '2160p': 'bestvideo[height<=2160]+bestaudio/best[height<=2160]',
  '1440p': 'bestvideo[height<=1440]+bestaudio/best[height<=1440]',
  '1080p': 'bestvideo[height<=1080]+bestaudio/best[height<=1080]',
  '720p': 'bestvideo[height<=720]+bestaudio/best[height<=720]',
  '480p': 'bestvideo[height<=480]+bestaudio/best[height<=480]',
  '360p': 'bestvideo[height<=360]+bestaudio/best[height<=360]',
};

app.post('/api/download', requireAuth, rateLimit, async (req, res) => {
  const { url, quality = 'best', type = 'video' } = req.body || {};
  if (!url || !(await isSafeUrl(url))) {
    return res.status(400).json({ error: 'A valid, public http(s) URL is required.' });
  }
  if (!['video', 'audio'].includes(type)) {
    return res.status(400).json({ error: "type must be 'video' or 'audio'." });
  }
  if (activeJobCount >= MAX_CONCURRENT_JOBS) {
    return res.status(429).json({ error: 'Server is busy processing other downloads — please try again in a moment.' });
  }

  const id = uuidv4();
  const job = {
    id,
    url,
    quality,
    type,
    status: 'processing',
    title: null,
    thumbnail: null,
    filePath: null,
    fileSize: null,
    error: null,
    createdAt: new Date().toISOString(),
  };
  await upsertJob(job);
  res.json({ jobId: id });

  activeJobCount++;
  processJob(id)
    .catch(async err => {
      const j = getJob(id);
      if (j) {
        j.status = 'failed';
        j.error = truncate(err.message);
        await upsertJob(j);
      }
    })
    .finally(() => {
      activeJobCount--;
    });
});

async function processJob(id) {
  const job = getJob(id);
  if (!job) return;

  let info = {};
  try {
    const { stdout } = await runYtDlp(['-j', '--no-playlist', job.url]);
    info = JSON.parse(stdout.trim().split('\n')[0]);
  } catch {
    // Non-fatal — proceed without metadata.
  }

  const outputTemplate = path.join(DOWNLOAD_DIR, `${id}.%(ext)s`);
  let args;

  if (job.type === 'audio') {
    args = [
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '0',
      '--no-playlist',
      '-o', outputTemplate,
      job.url,
    ];
  } else {
    const format = QUALITY_FORMATS[job.quality] || QUALITY_FORMATS.best;
    args = [
      '-f', format,
      '--merge-output-format', 'mp4',
      '--no-playlist',
      '-o', outputTemplate,
      job.url,
    ];
  }

  await runYtDlp(args);

  const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.startsWith(id));
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

app.get('/api/status/:id', requireAuth, (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  res.json(job);
});

app.get('/api/history', requireAuth, (req, res) => {
  const jobs = readJobs().filter(j => j.status === 'done');
  res.json(jobs);
});

app.delete('/api/history/:id', requireAuth, async (req, res) => {
  const jobs = readJobs();
  const job = jobs.find(j => j.id === req.params.id);
  if (job && job.filePath) {
    const fullPath = path.join(DOWNLOAD_DIR, job.filePath);
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
  }
  await withJobs(list => {
    const idx = list.findIndex(j => j.id === req.params.id);
    if (idx >= 0) list.splice(idx, 1);
  });
  res.json({ success: true });
});

app.get('/files/:id', requireAuth, (req, res) => {
  const job = getJob(req.params.id);
  if (!job || job.status !== 'done' || !job.filePath) {
    return res.status(404).json({ error: 'File not available.' });
  }
  const fullPath = path.join(DOWNLOAD_DIR, job.filePath);
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'File missing on disk.' });
  res.download(fullPath, job.filePath);
});

app.get('/health', (req, res) => res.json({ ok: true }));

// ---- Scheduled cleanup: delete finished downloads older than MAX_AGE_HOURS ----
const MAX_AGE_HOURS = Number(process.env.MAX_AGE_HOURS || 24);
async function cleanupOldFiles() {
  const cutoff = Date.now() - MAX_AGE_HOURS * 60 * 60 * 1000;
  await withJobs(jobs => {
    const keep = [];
    for (const job of jobs) {
      const age = new Date(job.createdAt).getTime();
      const expired = age < cutoff && job.status === 'done';
      if (expired && job.filePath) {
        const fullPath = path.join(DOWNLOAD_DIR, job.filePath);
        if (fs.existsSync(fullPath)) {
          try { fs.unlinkSync(fullPath); } catch { /* ignore */ }
        }
      }
      if (!expired) keep.push(job);
    }
    jobs.length = 0;
    jobs.push(...keep);
  });
}
setInterval(() => cleanupOldFiles().catch(() => {}), 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Downloader service running on port ${PORT}`);
  if (!ACCESS_PASSWORD) {
    console.warn('WARNING: ACCESS_PASSWORD is not set — this service is open to anyone with the URL.');
  }
});
