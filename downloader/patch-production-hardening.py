from pathlib import Path
import re

SERVER = Path('server.js')
HTML = Path('public/index.html')
s = SERVER.read_text(encoding='utf-8')

# 1) Stronger SSRF validation for public URL inputs.
old = "function isPrivateIp(ip) { if (ip.includes(':')) return ip === '::1' || ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd'); const [a, b] = ip.split('.').map(Number); return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0; }\nasync function isSafeUrl(value) { let url; try { url = new URL(value); } catch { return false; } if (!['http:', 'https:'].includes(url.protocol)) return false; try { const addresses = await dns.lookup(url.hostname, { all: true }); return addresses.every(({ address }) => !isPrivateIp(address)); } catch { return false; } }"
new = r'''function isPrivateIp(ip) {
  const raw = String(ip || '').trim().toLowerCase();
  if (!raw) return true;
  if (raw.includes(':') && raw.includes('.')) {
    const mapped = raw.slice(raw.lastIndexOf(':') + 1);
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(mapped)) return isPrivateIp(mapped);
  }
  if (!raw.includes(':')) {
    const octets = raw.split('.').map(Number);
    if (octets.length !== 4 || octets.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = octets;
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) || (a === 198 && b >= 18 && b <= 19) ||
      a >= 224;
  }
  const compact = raw.replace(/%.*$/, '');
  return compact === '::' || compact === '::1' || compact.startsWith('fe8') || compact.startsWith('fe9') ||
    compact.startsWith('fea') || compact.startsWith('feb') || compact.startsWith('fc') ||
    compact.startsWith('fd') || compact.startsWith('ff');
}

async function isSafeUrl(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  if (url.username || url.password) return false;
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) return false;
  try {
    const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    return addresses.length > 0 && addresses.every(({ address }) => !isPrivateIp(address));
  } catch { return false; }
}'''
if old in s:
    s = s.replace(old, new, 1)

# 2) Safe file-path helper + configurable output limit.
anchor = "const DOWNLOAD_DIR = path.join(DATA_DIR, 'downloads');\nconst DB_FILE = path.join(DATA_DIR, 'jobs.json');"
if anchor in s and 'const MAX_DOWNLOAD_BYTES =' not in s:
    s = s.replace(anchor, anchor + "\nconst MAX_DOWNLOAD_BYTES = Math.max(1, Number(process.env.MAX_DOWNLOAD_SIZE_MB || 1024)) * 1024 * 1024;", 1)
anchor = "function getJob(id) { return readJobs().find(job => job.id === id); }"
if anchor in s and 'function safeDownloadPath(' not in s:
    helper = r'''function safeDownloadPath(filePath) {
  const base = path.resolve(DOWNLOAD_DIR);
  const candidate = path.resolve(DOWNLOAD_DIR, path.basename(String(filePath || '')));
  return candidate === base || candidate.startsWith(`${base}${path.sep}`) ? candidate : null;
}
function assertDownloadSize(filePath) {
  const fullPath = safeDownloadPath(filePath);
  if (!fullPath || !fs.existsSync(fullPath)) throw new Error('The completed file is no longer available.');
  const size = fs.statSync(fullPath).size;
  if (size > MAX_DOWNLOAD_BYTES) throw new Error(`The completed file exceeds the ${Math.round(MAX_DOWNLOAD_BYTES / 1024 / 1024)} MB safety limit.`);
  return { fullPath, size };
}
'''
    s = s.replace(anchor, anchor + '\n\n' + helper, 1)

# 3) Secure session cookie and per-browser ownership in public mode.
old_login = "if (password === ACCESS_PASSWORD) { res.cookie('session', SESSION_TOKEN, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000 }); return res.json({ ok: true }); }"
new_login = "if (password === ACCESS_PASSWORD) { res.cookie('session', SESSION_TOKEN, { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/', maxAge: 30 * 24 * 60 * 60 * 1000 }); return res.json({ ok: true }); }"
s = s.replace(old_login, new_login, 1)
if 'function getClientId(req, res)' not in s:
    marker = "app.get('/api/me', (req, res) => {"
    idx = s.find(marker)
    if idx >= 0:
        insert = r'''function getClientId(req, res) {
  if (ACCESS_PASSWORD) return 'authenticated';
  const existing = String(req.cookies?.client_id || '').trim();
  if (/^[a-f0-9-]{20,80}$/i.test(existing)) return existing;
  const id = crypto.randomUUID();
  res.cookie('client_id', id, { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/', maxAge: 30 * 24 * 60 * 60 * 1000 });
  return id;
}
function ownsJob(job, clientId) { return !job || ACCESS_PASSWORD || job.ownerId === clientId; }

'''
        s = s[:idx] + insert + s[idx:]

# 4) Prevent unbounded growth of in-memory rate-limit state.
if 'RATE_LIMIT_MEMORY_CLEANUP' not in s:
    marker = "function truncate(str, max = 500) {"
    cleanup = "\nconst RATE_LIMIT_MEMORY_CLEANUP = setInterval(() => { const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS; for (const [ip, timestamps] of rateBuckets) { const fresh = timestamps.filter(ts => ts > cutoff); if (fresh.length) rateBuckets.set(ip, fresh); else rateBuckets.delete(ip); } }, 5 * 60 * 1000);\nRATE_LIMIT_MEMORY_CLEANUP.unref?.();\n"
    if marker in s: s = s.replace(marker, cleanup + marker, 1)

# 5) Ensure queued jobs have an owner id.
if "ownerId: getClientId(req, res)" not in s:
    s = s.replace("const id = uuidv4();\n  const job = { id, url, quality, type, status: 'processing'", "const id = uuidv4();\n  const ownerId = getClientId(req, res);\n  const job = { id, ownerId, url, quality, type, status: 'processing'", 1)
    s = s.replace("const job = { id, url, quality, type, status: 'processing', stage:", "const job = { id, ownerId: getClientId(req, res), url, quality, type, status: 'processing', stage:", 1)

# 6) Scope status/history/file access to the owning browser when no password is configured.
s = s.replace("app.get('/api/status/:id', requireAuth, (req, res) => { const job = getJob(req.params.id); if (!job) return res.status(404).json({ error: 'Job not found.' }); res.json(job); });", "app.get('/api/status/:id', requireAuth, (req, res) => { const clientId = getClientId(req, res); const job = getJob(req.params.id); if (!job || !ownsJob(job, clientId)) return res.status(404).json({ error: 'Job not found.' }); res.json(job); });", 1)
s = s.replace("app.get('/api/history', requireAuth, (req, res) => { res.json(readJobs().filter(job => job.status === 'done')); });", "app.get('/api/history', requireAuth, (req, res) => { const clientId = getClientId(req, res); res.json(readJobs().filter(job => job.status === 'done' && ownsJob(job, clientId))); });", 1)
s = re.sub(r"app\.delete\('/api/history/:id',[\s\S]*?\napp\.get\('/files/:id'", "app.delete('/api/history/:id', requireAuth, async (req, res) => { const clientId = getClientId(req, res); const jobs = readJobs(); const job = jobs.find(item => item.id === req.params.id); if (!job || !ownsJob(job, clientId)) return res.status(404).json({ error: 'Job not found.' }); if (job.filePath) { const stillReferenced = jobs.some(item => item.id !== req.params.id && item.filePath === job.filePath); if (!stillReferenced) { const fullPath = safeDownloadPath(job.filePath); if (fullPath && fs.existsSync(fullPath)) { try { fs.unlinkSync(fullPath); } catch {} } } } await withJobs(list => { const index = list.findIndex(item => item.id === req.params.id); if (index >= 0) list.splice(index, 1); }); res.json({ success: true }); });\napp.get('/files/:id'", s, count=1)
s = s.replace("app.get('/files/:id', requireAuth, (req, res) => { const clientId = getClientId(req, res); const job = getJob(req.params.id); if (!job || !ownsJob(job, clientId) || job.status !== 'done' || !job.filePath) return res.status(404).json({ error: 'File not available.' }); const fullPath = safeDownloadPath(job.filePath); if (!fullPath || !fs.existsSync(fullPath)) return res.status(404).json({ error: 'File missing on disk.' }); res.download(fullPath, path.basename(job.filePath)); });", "app.get('/files/:id', requireAuth, (req, res) => { const clientId = getClientId(req, res); const job = getJob(req.params.id); if (!job || !ownsJob(job, clientId) || job.status !== 'done' || !job.filePath) return res.status(404).json({ error: 'File not available.' }); const fullPath = safeDownloadPath(job.filePath); if (!fullPath || !fs.existsSync(fullPath)) return res.status(404).json({ error: 'File missing on disk.' }); res.download(fullPath, path.basename(job.filePath)); });", 1)

# 7) Queue every heavy TikTok photo/audio operation.
s = s.replace("const result = await processTikTokPhotoAudioJob(job, id, photo);", "const result = await downloadJobQueue.add(() => processTikTokPhotoAudioJob(job, id, photo), { urlHost: safeHost(job.url), operation: 'photo-audio', providerPlatform: 'tiktok' });", 1)

# 8) Use the robust completed-output selector and enforce the size limit.
s = s.replace("  const files = fs.readdirSync(DOWNLOAD_DIR).filter(file => file.startsWith(id));\n  if (!files.length) throw new Error('Download finished but no output file was found.');\n  const finalFile = files[0];\n  const fullPath = path.join(DOWNLOAD_DIR, finalFile);", "  const selectedOutput = selectCompletedOutput(DOWNLOAD_DIR, id, job.type);\n  if (!selectedOutput) throw new Error('Download finished but no completed output file was found.');\n  const finalFile = selectedOutput.name;\n  const fullPath = selectedOutput.fullPath;\n  const outputStat = assertDownloadSize(finalFile);", 1)
s = re.sub(r"  const files = fs\.readdirSync\(DOWNLOAD_DIR\)\.filter\(file =>\n    \(file\.startsWith\(id\) \|\| file\.startsWith\(`\$\{id\}-fallback`\)\) &&\n    !file\.endsWith\('\.part'\) && !file\.endsWith\('\.ytdl'\) && !file\.endsWith\('\.download'\)\n  \);\n  if \(!files\.length\) throw new Error\('Download finished but no output file was found\.'\);\n  const finalFile = files\[0\];\n  const fullPath = path\.join\(DOWNLOAD_DIR, finalFile\);", "  const selectedOutput = selectCompletedOutput(DOWNLOAD_DIR, id, job.type);\n  if (!selectedOutput) throw new Error('Download finished but no completed output file was found.');\n  const finalFile = selectedOutput.name;\n  const fullPath = selectedOutput.fullPath;\n  const outputStat = assertDownloadSize(finalFile);", s, count=1)
s = s.replace("updated.fileSize = fs.statSync(fullPath).size;", "updated.fileSize = outputStat.size;", 1)

# 9) Clean failed-job artifacts and stale interrupted jobs.
s = s.replace("current.status = 'failed'; current.stage = current.stage || 'validate'; current.progress = Math.min(Number(current.progress || 5), 95); current.stageMessage = 'The download could not be completed.'; current.error = truncate(error.message); await upsertJob(current);", "current.status = 'failed'; current.stage = current.stage || 'validate'; current.progress = Math.min(Number(current.progress || 5), 95); current.stageMessage = 'The download could not be completed.'; current.error = truncate(normalizeDownloadError ? normalizeDownloadError(error) : error.message); try { cleanupJobFiles(DOWNLOAD_DIR, id); } catch {} await upsertJob(current);", 1)
if "recoverInterruptedJobs" in s:
    s = s.replace("job.error = 'The downloader restarted before this job could finish. Please try again.';", "job.error = 'The downloader restarted before this job could finish. Please try again.'; try { cleanupJobFiles(DOWNLOAD_DIR, job.id); } catch {}", 1)

# 10) Prevent deletion of a file that another history entry still references.
def rewrite_cleanup_route(text):
    m = re.search(r"app\.delete\('/api/history/:id'", text)
    if not m: return text
    start = m.start()
    end = text.find("\napp.get('/files/:id'", start)
    if end < 0: return text
    replacement = "app.delete('/api/history/:id', requireAuth, async (req, res) => { const clientId = getClientId(req, res); const jobs = readJobs(); const job = jobs.find(item => item.id === req.params.id); if (!job || !ownsJob(job, clientId)) return res.status(404).json({ error: 'Job not found.' }); if (job.filePath) { const stillReferenced = jobs.some(item => item.id !== req.params.id && item.filePath === job.filePath); if (!stillReferenced) { const fullPath = safeDownloadPath(job.filePath); if (fullPath && fs.existsSync(fullPath)) { try { fs.unlinkSync(fullPath); } catch {} } } } await withJobs(list => { const index = list.findIndex(item => item.id === req.params.id); if (index >= 0) list.splice(index, 1); }); res.json({ success: true }); });"
    return text[:start] + replacement + text[end:]
s = rewrite_cleanup_route(s)

# 11) Make age cleanup reference-count aware.
cleanup_regex = r"async function cleanupOldFiles\(\) \{.*?\nsetInterval\(\(\) => cleanupOldFiles\(\)\.catch\(\(\) => \{\}\), 60 \* 60 \* 1000\);"
cleanup_new = "async function cleanupOldFiles() { const cutoff = Date.now() - MAX_AGE_HOURS * 60 * 60 * 1000; await withJobs(jobs => { const keep = []; const expired = []; for (const job of jobs) { const age = new Date(job.createdAt).getTime(); const isExpired = age < cutoff && job.status === 'done'; if (isExpired) expired.push(job); else keep.push(job); } const remainingPaths = new Set(keep.map(job => job.filePath).filter(Boolean)); for (const job of expired) { if (!job.filePath || remainingPaths.has(job.filePath)) continue; const fullPath = safeDownloadPath(job.filePath); if (fullPath && fs.existsSync(fullPath)) { try { fs.unlinkSync(fullPath); } catch {} } } jobs.length = 0; jobs.push(...keep); }); }\nsetInterval(() => cleanupOldFiles().catch(() => {}), 60 * 60 * 1000);"
s = re.sub(cleanup_regex, cleanup_new, s, count=1, flags=re.S)

# 12) Diagnostics exposes only whether optional credentials are configured, never their values.
needle = "poTokenProvider: 'bgutil-ytdlp-pot-provider HTTP'"
if needle in s and 'credentialConfiguration' not in s:
    s = s.replace(needle, needle + ",\n      credentialConfiguration: { youtubeCookiesConfigured: Boolean(process.env.YT_COOKIES_FILE || process.env.YT_COOKIES), accessPasswordConfigured: Boolean(ACCESS_PASSWORD) }", 1)

# 13) Public readiness probe: app + BgUtils health, no auth required.
if "app.get('/ready'" not in s:
    marker = "app.get('/health', (req, res) => res.json({ ok: true }));"
    if marker in s:
        s = s.replace(marker, marker + "\napp.get('/ready', async (req, res) => { try { const bg = await fetch('http://127.0.0.1:4416/ping', { signal: AbortSignal.timeout(1500) }); if (!bg.ok) return res.status(503).json({ ok: false, bgutil: false }); return res.json({ ok: true, bgutil: true }); } catch { return res.status(503).json({ ok: false, bgutil: false }); } });", 1)

SERVER.write_text(s, encoding='utf-8')
print('Production hardening patch applied')
