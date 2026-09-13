from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent
SERVER = ROOT / 'server.js'
HTML = ROOT / 'public' / 'index.html'

s = SERVER.read_text(encoding='utf-8')

start = s.index('// ---------- TikTok photo/slideshow support ----------')
end = s.index('// ---------- Rate limiting ----------', start)

section = r'''// ---------- TikTok photo/slideshow support ----------
// TikTok photo posts are intentionally handled outside yt-dlp. yt-dlp's
// normal extractor can report these as Unsupported URL, while the web page
// and item-detail response still expose imagePost + music metadata.
function isTikTokHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'tiktok.com' || host.endsWith('.tiktok.com');
}

function isTikTokPhotoPath(url) {
  try {
    const parsed = new URL(url);
    return isTikTokHost(parsed.hostname) && /^(?:\/\/@[^/]+)?\/photo\/\d+/.test(parsed.pathname);
  } catch {
    return false;
  }
}

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
  try { return JSON.parse(raw); } catch {
    const objectStart = raw.indexOf('{');
    const objectEnd = raw.lastIndexOf('}');
    if (objectStart >= 0 && objectEnd > objectStart) {
      try { return JSON.parse(raw.slice(objectStart, objectEnd + 1)); } catch {}
    }
    return null;
  }
}

function findObjectByKey(root, key) {
  const seen = new Set();
  function walk(value) {
    if (!value || typeof value !== 'object' || seen.has(value)) return null;
    seen.add(value);
    if (Object.prototype.hasOwnProperty.call(value, key)) return value[key];
    for (const child of Object.values(value)) {
      const found = walk(child);
      if (found !== null && found !== undefined) return found;
    }
    return null;
  }
  return walk(root);
}

function findTikTokItem(root, postId) {
  const seen = new Set();
  function walk(value) {
    if (!value || typeof value !== 'object' || seen.has(value)) return null;
    seen.add(value);
    const idMatches = !postId || String(value.id || '') === String(postId) || String(value.awemeId || '') === String(postId);
    if (idMatches && value.imagePost && (value.author || value.desc !== undefined)) return value;
    for (const child of Object.values(value)) {
      const found = walk(child);
      if (found) return found;
    }
    return null;
  }
  return walk(root);
}

function getTikTokItemFromData(data, postId) {
  if (!data) return null;
  const scopes = data.__DEFAULT_SCOPE__ || data;
  const detail = scopes?.['webapp.video-detail'] || scopes?.['webapp.reflow.video.detail'];
  const directItem = detail?.itemInfo?.itemStruct;
  if (directItem && (!postId || String(directItem.id || '') === String(postId))) return directItem;
  return findTikTokItem(data, postId) || findTikTokItem(findObjectByKey(data, 'itemStruct'), postId);
}

function extractTikTokPageData(html, postId) {
  const datasets = [
    extractScriptJson(html, '__UNIVERSAL_DATA_FOR_REHYDRATION__'),
    extractScriptJson(html, 'SIGI_STATE'),
    extractScriptJson(html, '__NEXT_DATA__')
  ].filter(Boolean);
  for (const data of datasets) {
    const item = getTikTokItemFromData(data, postId);
    if (item) return item;
  }
  return null;
}

function collectTikTokImageUrls(item) {
  const images = item?.imagePost?.images || item?.imagePost?.imageList || item?.image_post_info?.images || [];
  const urls = [];
  const seen = new Set();
  for (const image of images) {
    const candidates = image?.imageURL?.urlList || image?.image_url?.url_list || image?.display_image?.url_list || image?.urlList || image?.urls || [];
    for (const candidate of candidates) {
      if (typeof candidate !== 'string') continue;
      try {
        const parsed = new URL(candidate);
        const host = parsed.hostname.toLowerCase();
        if (!['http:', 'https:'].includes(parsed.protocol)) continue;
        if (!(host === 'tiktokcdn.com' || host.endsWith('.tiktokcdn.com') || host.endsWith('.tiktokcdn-us.com') || host.endsWith('.tiktokcdn-eu.com') || host.endsWith('.muscdn.com'))) continue;
        if (!seen.has(candidate)) { seen.add(candidate); urls.push(candidate); }
      } catch {}
      if (urls.length >= 35) break;
    }
    if (urls.length >= 35) break;
  }
  return urls;
}

function collectTikTokMusicUrl(item) {
  const candidates = [
    ...(Array.isArray(item?.music?.playUrl?.urlList) ? item.music.playUrl.urlList : []),
    ...(Array.isArray(item?.music?.play_url?.url_list) ? item.music.play_url.url_list : []),
    item?.music?.playAddr,
    item?.music?.playUrl,
    item?.imagePost?.music?.playUrl,
    item?.image_post_info?.music?.play_url
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    try {
      const parsed = new URL(candidate);
      const host = parsed.hostname.toLowerCase();
      if (['http:', 'https:'].includes(parsed.protocol) && (host === 'tiktokcdn.com' || host.endsWith('.tiktokcdn.com') || host.endsWith('.tiktokcdn-us.com') || host.endsWith('.tiktokcdn-eu.com') || host === 'muscdn.com' || host.endsWith('.muscdn.com'))) return candidate;
    } catch {}
  }
  return null;
}

const TIKTOK_HEADERS = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36', Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', 'Cache-Control': 'no-cache', Pragma: 'no-cache' };

function extractTikTokCanonicalUrl(html, fallback) {
  const patterns = [
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i,
    /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']twitter:url["'][^>]+content=["']([^"']+)["']/i
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (!match) continue;
    try {
      const candidate = new URL(match[1].replace(/&amp;/g, '&'), fallback);
      if (isTikTokHost(candidate.hostname)) return candidate.toString();
    } catch {}
  }
  const embedded = html.match(/(?:https?:\/\/(?:www\.)?tiktok\.com)?\/[^"'\s<>]*\/photo\/(\d+)/i);
  if (embedded) {
    const base = new URL(fallback);
    return `https://www.tiktok.com/photo/${embedded[1]}`;
  }
  return fallback;
}

async function fetchTikTokPage(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 30000);
  try {
    const response = await fetch(url, { redirect: 'follow', signal: controller.signal, headers: options.headers || TIKTOK_HEADERS });
    if (!response.ok) throw new Error(`TikTok returned HTTP ${response.status}.`);
    const html = await response.text();
    return { finalUrl: extractTikTokCanonicalUrl(html, response.url || url), networkUrl: response.url || url, html };
  } finally { clearTimeout(timer); }
}

async function fetchTikTokItemDetail(postId, referer) {
  const apiUrl = new URL('https://www.tiktok.com/api/item/detail/');
  apiUrl.searchParams.set('itemId', postId);
  apiUrl.searchParams.set('aid', '1988');
  apiUrl.searchParams.set('lang', 'en');
  apiUrl.searchParams.set('app_name', 'tiktok_web');
  apiUrl.searchParams.set('channel', 'tiktok_web');
  apiUrl.searchParams.set('device_platform', 'web_pc');
  apiUrl.searchParams.set('region', 'US');
  const response = await fetch(apiUrl.toString(), { redirect: 'follow', headers: { ...TIKTOK_HEADERS, Accept: 'application/json,text/plain,*/*', Referer: referer || 'https://www.tiktok.com/' } });
  if (!response.ok) throw new Error(`TikTok item detail returned HTTP ${response.status}.`);
  const payload = await response.json();
  return payload?.itemInfo?.itemStruct || null;
}

async function resolveTikTokPhoto(url) {
  const page = await fetchTikTokPage(url);
  const finalUrl = page.finalUrl;
  if (!isTikTokPhotoPath(finalUrl)) return null;
  const match = new URL(finalUrl).pathname.match(/(?:^|\/)photo\/(\d+)/);
  if (!match) throw new Error('Could not determine the TikTok photo post ID.');
  const postId = match[1];

  let item = extractTikTokPageData(page.html, postId);
  if (!item) {
    try { item = await fetchTikTokItemDetail(postId, finalUrl); } catch {}
  }
  if (!item) throw new Error('TikTok photo post was found, but its metadata could not be read.');

  const imageUrls = collectTikTokImageUrls(item);
  if (!imageUrls.length) throw new Error('This TikTok photo post contains no downloadable images.');
  return {
    postId,
    finalUrl,
    title: item.imagePost?.title || item.desc || 'TikTok photo slideshow',
    thumbnail: imageUrls[0],
    uploader: item.author?.nickname || item.author?.uniqueId || null,
    imageUrls,
    musicUrl: collectTikTokMusicUrl(item),
    musicTitle: item.music?.title || null
  };
}

async function tryResolveTikTokPhoto(url) {
  try { return await resolveTikTokPhoto(url); }
  catch (error) {
    // Do not let a failed TikTok photo resolver turn a known /photo/ post into
    // a generic yt-dlp Unsupported URL error. Return the real resolver error.
    try {
      const page = await fetchTikTokPage(url, { timeoutMs: 15000 });
      if (isTikTokPhotoPath(page.finalUrl)) throw error;
    } catch (secondError) {
      if (isTikTokPhotoPath(url)) throw error;
    }
    return null;
  }
}

async function downloadTikTokAsset(url, destination, referer) {
  let currentUrl = url;
  for (let hop = 0; hop < 5; hop++) {
    const parsed = new URL(currentUrl);
    const host = parsed.hostname.toLowerCase();
    if (!(host === 'tiktokcdn.com' || host.endsWith('.tiktokcdn.com') || host.endsWith('.tiktokcdn-us.com') || host.endsWith('.tiktokcdn-eu.com') || host === 'muscdn.com' || host.endsWith('.muscdn.com'))) throw new Error('TikTok returned an unsupported media host.');
    const response = await fetch(currentUrl, { redirect: 'manual', headers: { ...TIKTOK_HEADERS, Referer: referer, Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8' } });
    if ([301,302,303,307,308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('TikTok media server returned an invalid redirect.');
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    if (!response.ok) throw new Error(`TikTok image server returned HTTP ${response.status}.`);
    const maxImageBytes = 20 * 1024 * 1024;
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > maxImageBytes) throw new Error('A TikTok image exceeded the 20 MB safety limit.');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxImageBytes) throw new Error('A TikTok image exceeded the 20 MB safety limit.');
    fs.writeFileSync(destination, buffer);
    return;
  }
  throw new Error('Too many redirects while fetching the TikTok image.');
}

async function downloadTikTokAudioAsset(url, destination, referer) {
  let currentUrl = url;
  for (let hop = 0; hop < 5; hop++) {
    const parsed = new URL(currentUrl);
    const host = parsed.hostname.toLowerCase();
    if (!(host === 'tiktokcdn.com' || host.endsWith('.tiktokcdn.com') || host.endsWith('.tiktokcdn-us.com') || host.endsWith('.tiktokcdn-eu.com') || host === 'muscdn.com' || host.endsWith('.muscdn.com'))) throw new Error('TikTok returned an unsupported audio host.');
    const response = await fetch(currentUrl, { redirect: 'manual', headers: { ...TIKTOK_HEADERS, Referer: referer, Accept: 'audio/*,video/*;q=0.9,*/*;q=0.8' } });
    if ([301,302,303,307,308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('TikTok audio server returned an invalid redirect.');
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    if (!response.ok) throw new Error(`TikTok audio server returned HTTP ${response.status}.`);
    const maxAudioBytes = 30 * 1024 * 1024;
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > maxAudioBytes) throw new Error('The TikTok soundtrack exceeded the 30 MB safety limit.');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxAudioBytes) throw new Error('The TikTok soundtrack exceeded the 30 MB safety limit.');
    fs.writeFileSync(destination, buffer);
    return;
  }
  throw new Error('Too many redirects while fetching the TikTok soundtrack.');
}

function convertToMp3(source, destination) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-y', '-i', source, '-vn', '-codec:a', 'libmp3lame', '-q:a', '0', destination]);
    let stderr = '';
    proc.stderr.on('data', data => { stderr += data.toString(); });
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(stderr || 'Could not convert the TikTok soundtrack to MP3.')));
    proc.on('error', reject);
  });
}

async function processTikTokPhotoAudioJob(job, id, photo) {
  if (!photo.musicUrl) throw new Error('This TikTok photo post does not expose a downloadable soundtrack.');
  const sourcePath = path.join(DOWNLOAD_DIR, `${id}-tiktok-audio-source`);
  const outputPath = path.join(DOWNLOAD_DIR, `${id}-tiktok-audio.mp3`);
  try {
    await updateJobStage(id, 'download', 35, 'Downloading the TikTok slideshow soundtrack.');
    await downloadTikTokAudioAsset(photo.musicUrl, sourcePath, photo.finalUrl);
    await updateJobStage(id, 'process', 82, 'Converting the soundtrack to MP3.');
    await convertToMp3(sourcePath, outputPath);
    await updateJobStage(id, 'finalize', 95, 'Checking the MP3 and preparing your download.');
    return { title: photo.musicTitle ? `${photo.musicTitle} — TikTok soundtrack` : 'TikTok slideshow soundtrack', thumbnail: photo.thumbnail, duration: null, sourcePlatform: 'TikTok Photo Audio', filePath: path.basename(outputPath), fileSize: fs.statSync(outputPath).size, musicTitle: photo.musicTitle || null };
  } finally { try { fs.unlinkSync(sourcePath); } catch {} }
}

function createZipArchive(files, zipPath) { return new Promise((resolve, reject) => { const script = ['import sys, zipfile, os','out = sys.argv[1]','files = sys.argv[2:]','with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:','    for f in files:','        z.write(f, os.path.basename(f))'].join('\n'); const proc = spawn('python3', ['-c', script, zipPath, ...files]); let stderr = ''; proc.stderr.on('data', data => { stderr += data.toString(); }); proc.on('close', code => code === 0 ? resolve() : reject(new Error(stderr || 'Could not create the photo archive.'))); proc.on('error', reject); }); }
async function processTikTokPhotoJob(job, id, photo) { const imageFiles = []; const prefix = path.join(DOWNLOAD_DIR, `${id}-photo-`); try { await updateJobStage(id, 'download', 30, `Downloading ${photo.imageUrls.length} image(s) from the TikTok slideshow.`); for (let index = 0; index < photo.imageUrls.length; index++) { const assetUrl = photo.imageUrls[index]; let extension = 'jpg'; try { const pathname = new URL(assetUrl).pathname.toLowerCase(); if (pathname.endsWith('.png')) extension = 'png'; else if (pathname.endsWith('.webp')) extension = 'webp'; else if (pathname.endsWith('.heic')) extension = 'heic'; } catch {} const filePath = `${prefix}${String(index + 1).padStart(2, '0')}.${extension}`; await downloadTikTokAsset(assetUrl, filePath, photo.finalUrl); imageFiles.push(filePath); await updateJobStage(id, 'download', 30 + Math.round(((index + 1) / photo.imageUrls.length) * 45), `Downloaded ${index + 1} of ${photo.imageUrls.length} image(s).`); } if (!imageFiles.length) throw new Error('No images were downloaded from the TikTok post.'); const zipPath = path.join(DOWNLOAD_DIR, `${id}-tiktok-photos.zip`); await updateJobStage(id, 'process', 82, 'Packaging the downloaded images into a ZIP archive.'); await createZipArchive(imageFiles, zipPath); for (const file of imageFiles) { try { fs.unlinkSync(file); } catch {} } await updateJobStage(id, 'finalize', 95, 'Checking the ZIP archive and preparing your download.'); return { title: photo.title, thumbnail: photo.thumbnail, duration: null, sourcePlatform: 'TikTok Photo', filePath: path.basename(zipPath), fileSize: fs.statSync(zipPath).size, imageCount: imageFiles.length }; } catch (error) { for (const file of imageFiles) { try { fs.unlinkSync(file); } catch {} } throw error; } }

'''

s = s[:start] + section + s[end:]

# The stage-aware runtime patch owns processJob. Replace only its photo branch.
photo_pattern = re.compile(r"const photo = await tryResolveTikTokPhoto\(job\.url\);\n  if \(photo\) \{.*?\n  \}\n\n  await updateJobStage\(id, 'read_info'", re.S)
replacement = """const photo = await tryResolveTikTokPhoto(job.url);
  if (photo) {
    if (job.type === 'audio') {
      const result = await processTikTokPhotoAudioJob(job, id, photo);
      const updated = getJob(id);
      Object.assign(updated, result, { status: 'done', type: 'audio', stage: 'done', progress: 100, stageMessage: 'Download complete.' });
      await upsertJob(updated);
      return;
    }
    await updateJobStage(id, 'resolve', 24, `TikTok photo slideshow detected — ${photo.imageUrls.length} image(s).`);
    const result = await processTikTokPhotoJob(job, id, photo);
    const updated = getJob(id);
    Object.assign(updated, result, { status: 'done', type: 'photo', stage: 'done', progress: 100, stageMessage: 'Download complete.' });
    await upsertJob(updated);
    return;
  }

  await updateJobStage(id, 'read_info'"""
s, count = photo_pattern.subn(replacement, s, count=1)
if count != 1:
    raise SystemExit('Stage-aware processJob photo branch not found')

# Return photo metadata including soundtrack availability.
s = s.replace(
    "if (photo) return res.json({ title: photo.title, thumbnail: photo.thumbnail, duration: null, uploader: photo.uploader, extractor: 'TikTok Photo', contentType: 'photo', imageCount: photo.imageUrls.length, availableHeights: [] });",
    "if (photo) return res.json({ title: photo.title, thumbnail: photo.thumbnail, duration: null, uploader: photo.uploader, extractor: 'TikTok Photo', contentType: 'photo', imageCount: photo.imageUrls.length, hasAudio: Boolean(photo.musicUrl), musicTitle: photo.musicTitle || null, availableHeights: [] });",
    1,
)

SERVER.write_text(s, encoding='utf-8')

# Make the photo UI deterministic even if an earlier patch changed the same branch.
h = HTML.read_text(encoding='utf-8')
photo_ui = re.compile(r"if\(detectedContentType==='photo'\)\{.*?\}else\{", re.S)
photo_replacement = """if(detectedContentType==='photo'){
        clearPreview();
        typeSelect.disabled=false;
        qualitySelect.style.display='none';
        typeSelect.innerHTML='<option value=\"video\">Photos (ZIP)</option><option value=\"audio\">Soundtrack (MP3)</option>';
        typeSelect.value='video';
        detectedBox.textContent=data.hasAudio ? `TikTok photo slideshow detected — ${data.imageCount||'multiple'} image(s) can be saved as a ZIP, or download the attached soundtrack as MP3.` : `TikTok photo slideshow detected — ${data.imageCount||'multiple'} image(s) will be saved together as a ZIP. This post has no downloadable soundtrack.`;
        detectedBox.classList.remove('hidden');
      }else{"""
h, count = photo_ui.subn(photo_replacement, h, count=1)
if count != 1:
    raise SystemExit('Photo UI branch not found')
HTML.write_text(h, encoding='utf-8')

print('TikTok special-case resolver patched')