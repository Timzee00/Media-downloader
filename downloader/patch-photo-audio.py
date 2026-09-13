from pathlib import Path
import re

root = Path(__file__).resolve().parent
server = root / 'server.js'
html = root / 'public' / 'index.html'

s = server.read_text(encoding='utf-8')

s = s.replace(
    "return isTikTokHost(parsed.hostname) && /^\\/photo\\/\\d+/.test(parsed.pathname);",
    "return isTikTokHost(parsed.hostname) && /^(?:\\/@[^/]+)?\\/photo\\/\\d+/.test(parsed.pathname);",
)
s = s.replace(
    "const match = final.pathname.match(/^\\/photo\\/(\\d+)/);",
    "const match = final.pathname.match(/(?:^|\\/)photo\\/(\\d+)/);",
)

if "function collectTikTokMusicUrl(item)" not in s:
    marker = "function collectTikTokImageUrls(item) {"
    helper = r'''function collectTikTokMusicUrl(item) {
  const candidates = item?.music?.playUrl || item?.music?.play_url || [];
  const list = Array.isArray(candidates) ? candidates : [candidates];
  for (const candidate of list) {
    if (typeof candidate !== 'string') continue;
    try {
      const parsed = new URL(candidate);
      const host = parsed.hostname.toLowerCase();
      if (!['http:', 'https:'].includes(parsed.protocol)) continue;
      if (host === 'tiktokcdn.com' || host.endsWith('.tiktokcdn.com') || host.endsWith('.tiktokcdn-us.com') || host.endsWith('.tiktokcdn-eu.com')) return candidate;
    } catch {}
  }
  return null;
}

'''
    if marker not in s:
        raise SystemExit('Music helper insertion target not found')
    s = s.replace(marker, helper + marker, 1)

old_return = "return { postId, finalUrl, title: item.imagePost?.title || item.desc || 'TikTok photo slideshow', thumbnail: imageUrls[0], uploader: item.author?.nickname || item.author?.uniqueId || null, imageUrls };"
new_return = "return { postId, finalUrl, title: item.imagePost?.title || item.desc || 'TikTok photo slideshow', thumbnail: imageUrls[0], uploader: item.author?.nickname || item.author?.uniqueId || null, imageUrls, musicUrl: collectTikTokMusicUrl(item), musicTitle: item.music?.title || null };"
if old_return not in s:
    raise SystemExit('Photo return target not found')
s = s.replace(old_return, new_return, 1)

if "async function downloadTikTokAudioAsset" not in s:
    marker = "async function downloadTikTokAsset(url, destination, referer) {"
    helper = r'''async function downloadTikTokAudioAsset(url, destination, referer) {
  let currentUrl = url;
  for (let hop = 0; hop < 5; hop++) {
    if (!(await isSafeUrl(currentUrl))) throw new Error('TikTok audio URL failed the security check.');
    const parsed = new URL(currentUrl);
    const host = parsed.hostname.toLowerCase();
    if (!(host === 'tiktokcdn.com' || host.endsWith('.tiktokcdn.com') || host.endsWith('.tiktokcdn-us.com') || host.endsWith('.tiktokcdn-eu.com'))) throw new Error('TikTok returned an unsupported audio host.');
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

'''
    if marker not in s:
        raise SystemExit('Audio helper insertion target not found')
    s = s.replace(marker, helper + marker, 1)

if "async function processTikTokPhotoAudioJob" not in s:
    marker = "async function processTikTokPhotoJob(job, id, photo) {"
    helper = r'''async function processTikTokPhotoAudioJob(job, id, photo) {
  if (!photo.musicUrl) throw new Error('This TikTok photo post does not expose a downloadable soundtrack.');
  const sourcePath = path.join(DOWNLOAD_DIR, `${id}-tiktok-audio-source`);
  const outputPath = path.join(DOWNLOAD_DIR, `${id}-tiktok-audio.mp3`);
  try {
    await downloadTikTokAudioAsset(photo.musicUrl, sourcePath, photo.finalUrl);
    await convertToMp3(sourcePath, outputPath);
    return { title: photo.musicTitle ? `${photo.musicTitle} — TikTok soundtrack` : 'TikTok slideshow soundtrack', thumbnail: photo.thumbnail, duration: null, sourcePlatform: 'TikTok Photo Audio', filePath: path.basename(outputPath), fileSize: fs.statSync(outputPath).size, musicTitle: photo.musicTitle || null };
  } finally {
    try { fs.unlinkSync(sourcePath); } catch {}
  }
}

'''
    if marker not in s:
        raise SystemExit('Photo job insertion target not found')
    s = s.replace(marker, helper + marker, 1)

old_info = "if (photo) return res.json({ title: photo.title, thumbnail: photo.thumbnail, duration: null, uploader: photo.uploader, extractor: 'TikTok Photo', contentType: 'photo', imageCount: photo.imageUrls.length, availableHeights: [] });"
new_info = "if (photo) return res.json({ title: photo.title, thumbnail: photo.thumbnail, duration: null, uploader: photo.uploader, extractor: 'TikTok Photo', contentType: 'photo', imageCount: photo.imageUrls.length, hasAudio: Boolean(photo.musicUrl), musicTitle: photo.musicTitle || null, availableHeights: [] });"
if old_info not in s:
    raise SystemExit('Photo metadata target not found')
s = s.replace(old_info, new_info, 1)

old_process = "if (photo) {\n    if (job.type === 'audio') throw new Error('TikTok photo posts contain images, so audio-only download is not available.');\n    const result = await processTikTokPhotoJob(job, id, photo);"
new_process = "if (photo) {\n    if (job.type === 'audio') {\n      const result = await processTikTokPhotoAudioJob(job, id, photo);\n      const updated = getJob(id);\n      Object.assign(updated, result, { status: 'done', type: 'audio' });\n      await upsertJob(updated);\n      return;\n    }\n    const result = await processTikTokPhotoJob(job, id, photo);"
if old_process not in s:
    raise SystemExit('Photo processing target not found')
s = s.replace(old_process, new_process, 1)

server.write_text(s, encoding='utf-8')

h = html.read_text(encoding='utf-8')

if "Photos (ZIP)" not in h:
    pattern = r"if\(detectedContentType==='photo'\)\{.*?\}else\{"
    replacement = """if(detectedContentType==='photo'){
        clearPreview();
        typeSelect.disabled=false;
        qualitySelect.style.display='none';
        typeSelect.innerHTML='<option value=\"video\">Photos (ZIP)</option><option value=\"audio\">Soundtrack (MP3)</option>';
        typeSelect.value='video';
        detectedBox.textContent=data.hasAudio ? `TikTok photo slideshow detected — ${data.imageCount||'multiple'} image(s) can be saved as a ZIP, or download the attached soundtrack as MP3.` : `TikTok photo slideshow detected — ${data.imageCount||'multiple'} image(s) will be saved together as a ZIP. This post has no downloadable soundtrack.`;
        detectedBox.classList.remove('hidden');
      }else{"""
    h, count = re.subn(pattern, replacement, h, count=1, flags=re.S)
    if count != 1:
        raise SystemExit('Photo UI branch target not found')

old_clear = "clearTimeout(infoDebounce); detectedContentType='video'; detectedBox.classList.add('hidden'); clearPreview();"
new_clear = "clearTimeout(infoDebounce); detectedContentType='video'; detectedBox.classList.add('hidden'); clearPreview(); typeSelect.disabled=false; typeSelect.innerHTML='<option value=\"video\">Video (with sound)</option><option value=\"audio\">Sound only (MP3)</option>';"
if old_clear in h:
    h = h.replace(old_clear, new_clear, 1)

html.write_text(h, encoding='utf-8')
print('TikTok photo detection/audio patch applied')