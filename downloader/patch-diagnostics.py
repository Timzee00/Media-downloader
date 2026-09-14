from pathlib import Path

path = Path("server.js")
text = path.read_text(encoding="utf-8")

marker = "// ---------- TikTok photo/slideshow support ----------"
if "UNIVERSAL DOWNLOADER DIAGNOSTICS" not in text:
    diagnostic_block = r'''
// ---------- UNIVERSAL DOWNLOADER DIAGNOSTICS / ENGINE FALLBACKS ----------
const ENGINE_TIMEOUT_MS = Number(process.env.DOWNLOADER_ENGINE_TIMEOUT_MS || 180000);
const DIAGNOSTIC_MAX_DETAIL = 1600;
const providerRouter = require('./provider-router');

function safeHost(value) {
  try { return new URL(value).hostname; } catch { return 'unknown'; }
}
function compactDetail(value, max = DIAGNOSTIC_MAX_DETAIL) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max) + ' ...' : text;
}
function diagLog(event, data = {}) {
  try { console.log(`[downloader] ${JSON.stringify({ event, ts: new Date().toISOString(), ...data })}`); }
  catch { console.log(`[downloader] ${event}`); }
}
function engineLabel(command) {
  return command === 'yt-dlp' ? 'yt-dlp' : command === 'you-get' ? 'you-get' : command === 'gallery-dl' ? 'gallery-dl' : command;
}

function runExternalEngine(command, args, meta = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const rendered = args.map(arg => /^https?:\/\//i.test(String(arg)) ? `[url:${safeHost(arg)}]` : String(arg));
    diagLog('engine_start', { engine: engineLabel(command), args: rendered, ...meta });
    const proc = spawn(command, args);
    let stdout = '';
    let stderr = '';
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      diagLog('engine_timeout', { engine: engineLabel(command), elapsedMs: Date.now() - started, ...meta });
      try { proc.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000).unref();
    }, ENGINE_TIMEOUT_MS);
    proc.stdout.on('data', data => { stdout += data.toString(); });
    proc.stderr.on('data', data => { stderr += data.toString(); });
    proc.on('close', code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const elapsedMs = Date.now() - started;
      if (code === 0) {
        diagLog('engine_success', { engine: engineLabel(command), code, elapsedMs, ...meta });
        return resolve({ stdout, stderr });
      }
      diagLog('engine_failure', { engine: engineLabel(command), code, elapsedMs, detail: compactDetail(stderr), ...meta });
      reject(new Error(stderr || `${command} exited with code ${code}`));
    });
    proc.on('error', error => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      diagLog('engine_error', { engine: engineLabel(command), error: compactDetail(error.message), ...meta });
      reject(error);
    });
  });
}

async function runYouGet(url, destinationPrefix, meta = {}) {
  return runExternalEngine('you-get', ['-o', DOWNLOAD_DIR, '-O', destinationPrefix, url], {
    urlHost: safeHost(url),
    fallback: true,
    ...meta,
  });
}

async function probeBgutilProvider() {
  try {
    const started = Date.now();
    const response = await fetch('http://127.0.0.1:4416/ping', { signal: AbortSignal.timeout(2500) });
    const body = await response.text();
    return { ok: response.ok, status: response.status, elapsedMs: Date.now() - started, body: compactDetail(body, 300) };
  } catch (error) {
    return { ok: false, error: compactDetail(error.message, 300) };
  }
}

let _engineVersionsPromise = null;
async function getEngineVersions() {
  if (!_engineVersionsPromise) {
    _engineVersionsPromise = Promise.all([
      runExternalEngine('yt-dlp', ['--version'], { diagnostic: true }).then(r => r.stdout.trim() || r.stderr.trim()).catch(() => 'unavailable'),
      runExternalEngine('you-get', ['--version'], { diagnostic: true }).then(r => r.stdout.trim() || r.stderr.trim()).catch(() => 'unavailable'),
      runExternalEngine('gallery-dl', ['--version'], { diagnostic: true }).then(r => r.stdout.trim() || r.stderr.trim()).catch(() => 'unavailable')
    ]).then(([ytDlp, youGet, galleryDl]) => ({ ytDlp, youGet, galleryDl }));
  }
  return _engineVersionsPromise;
}

async function universalDiagnostics() {
  const engines = await getEngineVersions();
  const bgutil = await probeBgutilProvider();
  return {
    ok: true,
    node: process.version,
    platform: process.platform,
    engines,
    bgutil,
    routing: {
      providerRouter: 'enabled',
      supportedPlatforms: ['youtube', 'tiktok', 'instagram', 'facebook', 'x', 'threads', 'reddit', 'generic'],
      primary: 'yt-dlp',
      videoFallback: 'you-get',
      galleryEngine: 'gallery-dl (installed; reserved for future gallery/image routing)',
      youtubeClients: 'default,web_embedded',
      poTokenProvider: 'bgutil-ytdlp-pot-provider HTTP'
    }
  };
}

if (!global.__MEDIA_DOWNLOADER_DIAG_MIDDLEWARE__) {
  global.__MEDIA_DOWNLOADER_DIAG_MIDDLEWARE__ = true;
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    const requestId = crypto.randomUUID();
    req.diagRequestId = requestId;
    const bodyUrl = req.body && typeof req.body.url === 'string' ? req.body.url : null;
    const providerPlatform = bodyUrl ? providerRouter.classifyPlatform(bodyUrl) : null;
    diagLog('request_start', {
      requestId,
      method: req.method,
      path: req.path,
      urlHost: bodyUrl ? safeHost(bodyUrl) : null,
      providerPlatform,
    });
    res.on('finish', () => diagLog('request_finish', {
      requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      urlHost: bodyUrl ? safeHost(bodyUrl) : null,
      providerPlatform,
    }));
    next();
  });
}

app.get('/api/diagnostics', requireAuth, async (req, res) => {
  try { return res.json(await universalDiagnostics()); }
  catch (error) { return res.status(500).json({ ok: false, error: compactDetail(error.message, 500) }); }
});

'''
    if marker not in text:
        raise SystemExit("Expected TikTok marker not found")
    text = text.replace(marker, diagnostic_block + marker, 1)

old_run = "function runYtDlp(args) { return new Promise((resolve, reject) => { const proc = spawn('yt-dlp', args); let stdout = ''; let stderr = ''; proc.stdout.on('data', data => { stdout += data.toString(); }); proc.stderr.on('data', data => { stderr += data.toString(); }); proc.on('close', code => { if (code === 0) return resolve({ stdout, stderr }); reject(new Error(stderr || `yt-dlp exited with code ${code}`)); }); proc.on('error', reject); }); }"
new_run = r'''function runYtDlp(args) {
  const url = providerRouter.extractUrl(args);
  const operation = args.includes('-j') || args.includes('--dump-json') ? 'metadata' : 'download';
  return providerRouter.runProviderPlan({
    url,
    args,
    operation,
    runEngine: runExternalEngine,
    runYouGet: (targetUrl, destinationPrefix, meta) => runYouGet(targetUrl, destinationPrefix, meta),
    destinationPrefix: args[args.indexOf('-o') + 1] || null,
    meta: { urlHost: safeHost(url), operation },
  });
}'''
if old_run in text:
    text = text.replace(old_run, new_run, 1)

old_download = "  await runYtDlp(args);\n  const files = fs.readdirSync(DOWNLOAD_DIR).filter(file => file.startsWith(id));"
new_download = r'''  await runYtDlp(args);
  const files = fs.readdirSync(DOWNLOAD_DIR).filter(file =>
    (file.startsWith(id) || file.startsWith(`${id}-fallback`)) &&
    !file.endsWith('.part') && !file.endsWith('.ytdl') && !file.endsWith('.download')
  );'''
if old_download in text:
    text = text.replace(old_download, new_download, 1)

# Allow the UI to proceed to the download engine even when yt-dlp metadata lookup is unavailable.
old_info = "    const { stdout } = await runYtDlp(['-j', '--no-playlist', url]);\n    const info = JSON.parse(stdout.trim().split('\\n')[0]);\n    return res.json({ title: info.title, thumbnail: info.thumbnail, duration: info.duration, uploader: info.uploader, extractor: info.extractor, contentType: 'video', availableHeights: [...new Set((info.formats || []).map(format => format.height).filter(Boolean))].sort((a, b) => b - a) });"
new_info = r'''    try {
      const { stdout } = await runYtDlp(['-j', '--no-playlist', url]);
      const info = JSON.parse(stdout.trim().split('\n')[0]);
      return res.json({ title: info.title, thumbnail: info.thumbnail, duration: info.duration, uploader: info.uploader, extractor: info.extractor, contentType: 'video', availableHeights: [...new Set((info.formats || []).map(format => format.height).filter(Boolean))].sort((a, b) => b - a) });
    } catch (primaryError) {
      // Metadata is helpful but should not prevent the actual download route
      // from trying the configured provider plan.
      diagLog('metadata_degraded', {
        urlHost: safeHost(url),
        providerPlatform: providerRouter.classifyPlatform(url),
        primary: 'yt-dlp',
        detail: compactDetail(primaryError.message, 900),
      });
      return res.json({
        title: `Media from ${safeHost(url)}`,
        thumbnail: null,
        duration: null,
        uploader: null,
        extractor: 'metadata-unavailable',
        contentType: 'video',
        availableHeights: []
      });
    }'''
if old_info in text:
    text = text.replace(old_info, new_info, 1)

path.write_text(text, encoding="utf-8")
print("Universal downloader diagnostics patch integrated with provider router")