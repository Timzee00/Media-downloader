from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent
SERVER = ROOT / 'server.js'
HTML = ROOT / 'public' / 'index.html'

s = SERVER.read_text(encoding='utf-8')

# Add a lightweight detector that only follows TikTok's redirect/canonical URL.
# It deliberately does not attempt to extract or download photo-post media.
marker = "async function tryResolveTikTokPhoto(url) {"
if "async function isUnsupportedTikTokPhotoLink(url)" not in s:
    guard = r'''async function isUnsupportedTikTokPhotoLink(url) {
  try {
    const parsed = new URL(url);
    if (!isTikTokHost(parsed.hostname)) return false;
    const page = await fetchTikTokPage(url, { timeoutMs: 12000 });
    return isTikTokPhotoPath(page.finalUrl);
  } catch {
    return false;
  }
}

'''
    if marker not in s:
        raise SystemExit('TikTok resolver marker not found')
    s = s.replace(marker, guard + marker, 1)

# /api/info: reject a photo post before trying any resolver or yt-dlp fallback.
info_old = "  try {\n    const photo = await tryResolveTikTokPhoto(url);"
info_new = "  try {\n    if (await isUnsupportedTikTokPhotoLink(url)) {\n      return res.status(422).json({\n        error: 'TikTok photo posts are not supported.',\n        code: 'TIKTOK_PHOTO_UNSUPPORTED',\n        contentType: 'photo',\n        detail: 'This link contains a TikTok photo post rather than a video. Please use a TikTok video link.'\n      });\n    }\n    const photo = await tryResolveTikTokPhoto(url);"
if info_old in s and info_new not in s:
    s = s.replace(info_old, info_new, 1)

# /api/download: reject before creating a job, so photo posts never enter the
# normal video pipeline and never produce yt-dlp "Unsupported URL" noise.
download_pattern = re.compile(r"(app\.post\('/api/download', requireAuth, rateLimit, async \(req, res\) => \{\n\s*const \{ url, quality = 'best', type = 'video' \} = req\.body \|\| \{\};\n)")
match = download_pattern.search(s)
if match and 'TIKTOK_PHOTO_UNSUPPORTED' not in s[match.start():match.start()+1800]:
    guard = """\n  if (url && await isUnsupportedTikTokPhotoLink(url)) {\n    return res.status(422).json({\n      error: 'TikTok photo posts are not supported.',\n      code: 'TIKTOK_PHOTO_UNSUPPORTED',\n      contentType: 'photo',\n      detail: 'This link contains a TikTok photo post rather than a video. Please use a TikTok video link.'\n    });\n  }\n"""
    s = s[:match.end()] + guard + s[match.end():]

SERVER.write_text(s, encoding='utf-8')

# Make the message explicit in the frontend as a safety net. This runs before
# the app's existing error rendering and only changes this one error code.
h = HTML.read_text(encoding='utf-8')
needle = '</body>'
script = r'''<script>
(function () {
  const originalFetch = window.fetch.bind(window);
  window.fetch = async function(input, init) {
    const response = await originalFetch(input, init);
    try {
      const requestUrl = typeof input === 'string' ? input : input.url;
      if (requestUrl && (requestUrl.includes('/api/info') || requestUrl.includes('/api/download')) && !response.ok) {
        const clone = response.clone();
        const data = await clone.json().catch(() => null);
        if (data && data.code === 'TIKTOK_PHOTO_UNSUPPORTED') {
          return new Response(JSON.stringify({
            ...data,
            error: 'TikTok photo post detected. Photo downloads are not supported yet. Please use a TikTok video link.'
          }), { status: response.status, headers: { 'Content-Type': 'application/json' } });
        }
      }
    } catch {}
    return response;
  };
})();
</script>
'''
if 'TIKTOK_PHOTO_UNSUPPORTED' not in h:
    if needle not in h:
        raise SystemExit('HTML body marker not found')
    h = h.replace(needle, script + needle, 1)
    HTML.write_text(h, encoding='utf-8')

print('TikTok photo-post disable guard applied')
