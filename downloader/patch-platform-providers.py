from pathlib import Path

path = Path('server.js')
text = path.read_text(encoding='utf-8')

if "const platformProviders = require('./platform-providers');" not in text:
    marker = "const providerRouter = require('./provider-router');"
    if marker not in text:
        raise SystemExit('Provider router import marker not found')
    text = text.replace(marker, marker + "\nconst platformProviders = require('./platform-providers');", 1)

if "app.get('/api/providers'," not in text:
    marker = "app.get('/api/diagnostics', requireAuth, async (req, res) => {"
    if marker not in text:
        raise SystemExit('Diagnostics route marker not found')
    route = "app.get('/api/providers', requireAuth, (req, res) => res.json({ ok: true, providers: platformProviders.providerSummary() }));\n\n"
    text = text.replace(marker, route + marker, 1)

path.write_text(text, encoding='utf-8')
print('Platform provider capability route applied')
