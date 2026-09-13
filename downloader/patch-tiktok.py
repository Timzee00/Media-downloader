from pathlib import Path

p = Path(__file__).resolve().parent / 'server.js'
s = p.read_text(encoding='utf-8')

if 'function extractTikTokCanonicalUrl(' not in s:
    start_marker = 'async function fetchTikTokPage(url) {'
    next_marker = 'async function resolveTikTokPhoto'
    start = s.find(start_marker)
    end = s.find(next_marker, start + len(start_marker)) if start >= 0 else -1
    if start < 0 or end < 0:
        raise SystemExit('Could not locate fetchTikTokPage')

    replacement = '''function extractTikTokCanonicalUrl(html, fallback) {
  const patterns = [
    /<link[^>]+rel=[\\\"']canonical[\\\"'][^>]+href=[\\\"']([^\\\"']+)[\\\"']/i,
    /<meta[^>]+property=[\\\"']og:url[\\\"'][^>]+content=[\\\"']([^\\\"']+)[\\\"']/i,
    /<meta[^>]+name=[\\\"']twitter:url[\\\"'][^>]+content=[\\\"']([^\\\"']+)[\\\"']/i
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (!match) continue;
    try {
      const candidate = new URL(match[1].replace(/&amp;/g, '&'), fallback);
      if (isTikTokHost(candidate.hostname)) return candidate.toString();
    } catch {}
  }
  const embedded = html.match(/(?:https?:\\/\\/(?:www\\.)?tiktok\\.com)?\\/[^\\\"'\\s<>]*\\/photo\\/(\\d+)/i);
  if (embedded) {
    try {
      const base = new URL(fallback);
      return `https://${base.hostname}/photo/${embedded[1]}`;
    } catch {}
  }
  return fallback;
}

async function fetchTikTokPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, { redirect: 'follow', signal: controller.signal, headers: TIKTOK_HEADERS });
    if (!response.ok) throw new Error(`TikTok returned HTTP ${response.status}.`);
    const html = await response.text();
    const networkUrl = response.url || url;
    const finalUrl = extractTikTokCanonicalUrl(html, networkUrl);
    return { finalUrl, html };
  } finally {
    clearTimeout(timer);
  }
}

'''

    s = s[:start] + replacement + s[end:]

p.write_text(s, encoding='utf-8')
print('TikTok resolver patch applied')
