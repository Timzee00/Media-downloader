from pathlib import Path

server = Path('server.js')
text = server.read_text(encoding='utf-8')

# Import the reusable format/output/error helpers once.
if "const downloadUtils = require('./download-utils');" not in text:
    marker = "const providerRouter = require('./provider-router');"
    if marker not in text:
        raise SystemExit('Provider router import marker not found')
    text = text.replace(marker, marker + "\nconst downloadUtils = require('./download-utils');", 1)

# Replace the simple format map with format selection that prefers common
# MP4/M4A combinations while retaining safe fallbacks for other sites.
old_formats = "const QUALITY_FORMATS = { best: 'bestvideo+bestaudio/best', '2160p': 'bestvideo[height<=2160]+bestaudio/best[height<=2160]', '1440p': 'bestvideo[height<=1440]+bestaudio/best[height<=1440]', '1080p': 'bestvideo[height<=1080]+bestaudio/best[height<=1080]', '720p': 'bestvideo[height<=720]+bestaudio/best[height<=720]', '480p': 'bestvideo[height<=480]+bestaudio/best[height<=480]', '360p': 'bestvideo[height<=360]+bestaudio/best[height<=360]' };"
new_formats = "const { QUALITY_FORMATS, selectCompletedOutput, cleanupJobFiles, normalizeDownloadError } = downloadUtils;"
if old_formats in text:
    text = text.replace(old_formats, new_formats, 1)

# Let the queue be the single concurrency controller. The old active-job gate
# rejected requests before they could enter the bounded queue.
old_rate = "const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000, RATE_LIMIT_MAX = 15, MAX_CONCURRENT_JOBS = 2;\nconst rateBuckets = new Map(); let activeJobCount = 0;"
new_rate = "const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000, RATE_LIMIT_MAX = 15;\nconst rateBuckets = new Map();"
if old_rate in text:
    text = text.replace(old_rate, new_rate, 1)

old_gate = "  if (activeJobCount >= MAX_CONCURRENT_JOBS) return res.status(429).json({ error: 'Server is busy processing other downloads — please try again in a moment.' });\n"
if old_gate in text:
    text = text.replace(old_gate, "  const queueState = downloadJobQueue.snapshot();\n  if (!queueState.accepting && queueState.running >= queueState.concurrency) return res.status(429).json({ error: 'Download queue is full — please try again in a moment.' });\n", 1)

old_create = "  activeJobCount++;\n  processJob(id).catch(async error => { const current = getJob(id); if (!current) return; current.status = 'failed'; current.error = truncate(error.message); await upsertJob(current); }).finally(() => { activeJobCount--; });"
new_create = "  processJob(id).catch(async error => { const current = getJob(id); if (!current) return; const friendlyError = normalizeDownloadError(error); diagLog('job_failed', { jobId: id, providerPlatform: providerRouter.classifyPlatform(current.url), detail: compactDetail(error.message || error) }); cleanupJobFiles(DOWNLOAD_DIR, id); current.status = 'failed'; current.error = truncate(friendlyError); await upsertJob(current); });"
if old_create in text:
    text = text.replace(old_create, new_create, 1)

# Put TikTok photo processing through the same bounded queue as yt-dlp jobs.
old_photo = "    const result = await processTikTokPhotoJob(job, id, photo);"
new_photo = "    const result = await downloadJobQueue.add(() => processTikTokPhotoJob(job, id, photo), { urlHost: safeHost(job.url), operation: 'photo-download', providerPlatform: 'tiktok' });"
if old_photo in text:
    text = text.replace(old_photo, new_photo, 1)

# Use the helper to select a completed output instead of the first matching
# directory entry; partial/temp files are ignored and type is respected.
old_files = "  const files = fs.readdirSync(DOWNLOAD_DIR).filter(file =>\n    (file.startsWith(id) || file.startsWith(`${id}-fallback`)) &&\n    !file.endsWith('.part') && !file.endsWith('.ytdl') && !file.endsWith('.download')\n  );\n  if (!files.length) throw new Error('Download finished but no output file was found.');\n  const finalFile = files[0];\n  const fullPath = path.join(DOWNLOAD_DIR, finalFile);"
new_files = "  const selectedOutput = selectCompletedOutput(DOWNLOAD_DIR, id, job.type);\n  if (!selectedOutput) throw new Error('Download finished but no completed output file was found.');\n  const finalFile = selectedOutput.name;\n  const fullPath = selectedOutput.fullPath;"
if old_files in text:
    text = text.replace(old_files, new_files, 1)

# Recover jobs that were marked processing when the container restarted.
if 'function recoverInterruptedJobs()' not in text:
    marker = "const PORT = Number(process.env.PORT || 3000);"
    recovery = r'''async function recoverInterruptedJobs() {
  await withJobs(jobs => {
    let recovered = 0;
    for (const job of jobs) {
      if (job.status !== 'processing') continue;
      job.status = 'failed';
      job.error = 'The downloader restarted before this job could finish. Please try again.';
      recovered += 1;
    }
    if (recovered) diagLog('recovered_interrupted_jobs', { count: recovered });
  });
}

recoverInterruptedJobs().catch(error => diagLog('job_recovery_error', { detail: compactDetail(error.message) }));

'''
    if marker not in text:
        raise SystemExit('PORT marker not found')
    text = text.replace(marker, recovery + marker, 1)

server.write_text(text, encoding='utf-8')

# ---- Frontend branding ----
index = Path('public/index.html')
html = index.read_text(encoding='utf-8')
html = html.replace('<title>Media Downloader</title>', '<title>Media Downloader — Powered by Timzee Corp</title>', 1)
if 'class="brand-footer"' not in html:
    css_marker = '  @keyframes spin { to { transform:rotate(360deg); } }'
    css = '  .brand-footer { text-align:center; padding:0 20px 28px; color:var(--muted); font-size:11px; letter-spacing:.02em; }\n  .brand-footer strong { color:var(--text); font-weight:700; }\n'
    if css_marker not in html:
        raise SystemExit('Frontend CSS marker not found')
    html = html.replace(css_marker, css_marker + '\n' + css, 1)

    footer = '  <footer class="brand-footer" aria-label="Powered by Timzee Corp">Powered by <strong>Timzee Corp</strong></footer>\n'
    if '</body>' not in html:
        raise SystemExit('Frontend closing body marker not found')
    html = html.replace('</body>', footer + '</body>', 1)

index.write_text(html, encoding='utf-8')

print('Download hardening and Timzee Corp branding patch applied')
