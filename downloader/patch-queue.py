from pathlib import Path

path = Path('server.js')
text = path.read_text(encoding='utf-8')

if 'const downloadJobQueue = require(\'./queue-manager\');' not in text:
    marker = "const providerRouter = require('./provider-router');"
    if marker not in text:
        raise SystemExit('Provider router import marker not found')
    replacement = marker + "\nconst { JobQueue } = require('./queue-manager');\nconst downloadJobQueue = new JobQueue({\n  concurrency: Number(process.env.DOWNLOADER_QUEUE_CONCURRENCY || 2),\n  maxPending: Number(process.env.DOWNLOADER_QUEUE_MAX_PENDING || 20),\n  onEvent: (event, data) => diagLog(`queue_${event}`, data),\n});"
    text = text.replace(marker, replacement, 1)

old = '  await runYtDlp(args);'
new = "  await downloadJobQueue.add(() => runYtDlp(args), { urlHost: safeHost(url), operation: 'download' });"
if old in text:
    text = text.replace(old, new, 1)

queue_diag_marker = "app.get('/api/diagnostics', requireAuth, async (req, res) => {"
if "app.get('/api/queue'," not in text:
    if queue_diag_marker not in text:
        raise SystemExit('Diagnostics route marker not found')
    route = "app.get('/api/queue', requireAuth, (req, res) => res.json({ ok: true, ...downloadJobQueue.snapshot() }));\n\n"
    text = text.replace(queue_diag_marker, route + queue_diag_marker, 1)

path.write_text(text, encoding='utf-8')
print('Download queue patch applied')
