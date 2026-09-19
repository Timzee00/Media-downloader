from pathlib import Path

p = Path('server.js')
s = p.read_text()

import_needle = "const { v4: uuidv4 } = require('uuid');\n"
if "./providers/curiousapi" not in s:
    if import_needle not in s:
        raise SystemExit('import target not found')
    s = s.replace(
        import_needle,
        import_needle
        + "const curiousapi = require('./providers/curiousapi');\n"
        + "const vidkraken = require('./providers/vidkraken');\n",
        1,
    )

helper_needle = "// ---------- Download ----------\n"
if "async function downloadCuriousApiProvider" not in s:
    if helper_needle not in s:
        raise SystemExit('download marker not found')
    helper = '''async function downloadCuriousApiProvider(job, info = {}) {
  if (job.type !== 'video') throw new Error('CuriousAPI fallback supports video jobs only.');
  const temporaryPath = path.join(DOWNLOAD_DIR, job.id + '.curious.tmp');
  const result = await curiousapi.downloadToFile(job.url, temporaryPath, {
    maxBytes: Number(process.env.MAX_DOWNLOAD_SIZE_MB || 1024) * 1024 * 1024,
    isSafeDownloadUrl: isSafeUrl,
  });
  const rawExt = path.extname(result.filename || '').toLowerCase();
  const ext = ['.mp4', '.webm', '.mkv', '.mov', '.m4v', '.avi'].includes(rawExt)
    ? rawExt
    : (String(result.contentType || '').includes('webm') ? '.webm' : '.mp4');
  const finalPath = path.join(DOWNLOAD_DIR, job.id + ext);
  try {
    if (temporaryPath !== finalPath) fs.renameSync(temporaryPath, finalPath);
  } catch (error) {
    try { fs.unlinkSync(temporaryPath); } catch {}
    throw error;
  }
  const metadata = result.metadata || {};
  return {
    filePath: path.basename(finalPath),
    fileSize: result.fileSize,
    title: metadata.title || info.title || 'Downloaded video',
    thumbnail: metadata.thumbnail || info.thumbnail || null,
    duration: metadata.duration ?? info.duration ?? null,
    uploader: metadata.uploader || info.uploader || null,
    sourcePlatform: metadata.extractor || info.extractor || 'CuriousAPI',
  };
}

async function downloadVidKrakenProvider(job, info = {}) {
  if (job.type !== 'video') throw new Error('VidKraken fallback supports video jobs only.');
  const format = job.quality === 'best' ? '1080' : String(job.quality).replace(/p$/i, '');
  const submitted = await vidkraken.submitDownload(job.url, format);
  const completed = await vidkraken.waitForDownload(submitted.jobId);
  const response = await fetch(completed.downloadUrl, { redirect: 'follow' });
  if (!response.ok) throw new Error('External provider download returned HTTP ' + response.status + '.');
  const contentType = response.headers.get('content-type') || 'video/mp4';
  const extension = contentType.includes('webm') ? 'webm' : 'mp4';
  const filePath = path.join(DOWNLOAD_DIR, job.id + '.' + extension);
  const contentLength = Number(response.headers.get('content-length') || 0);
  const maxBytes = Number(process.env.MAX_DOWNLOAD_SIZE_MB || 1024) * 1024 * 1024;
  if (contentLength > maxBytes) throw new Error('External provider returned a file larger than the configured download limit.');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) throw new Error('External provider returned a file larger than the configured download limit.');
  fs.writeFileSync(filePath, buffer);
  const metadata = { ...(submitted.metadata || {}), ...(completed.metadata || {}) };
  return {
    filePath: path.basename(filePath),
    fileSize: buffer.length,
    metadata: {
      title: metadata.title || info.title || 'Downloaded video',
      thumbnail: metadata.thumbnail || info.thumbnail || null,
      duration: metadata.duration ?? info.duration ?? null,
      uploader: metadata.uploader || info.uploader || null,
      extractor: metadata.extractor || info.extractor || null,
    },
  };
}

'''
    s = s.replace(helper_needle, helper + helper_needle, 1)

old_download = "  await downloadJobQueue.add(() => runYtDlp(args), { urlHost: safeHost(providerRouter.extractUrl(args) || ''), operation: 'download' });"
if old_download not in s:
    old_download = "  await runYtDlp(args);"
new_download = '''  try {
    await downloadJobQueue.add(() => runYtDlp(args), { urlHost: safeHost(providerRouter.extractUrl(args) || ''), operation: 'download' });
  } catch (primaryError) {
    console.warn('[yt-dlp] ' + truncate(primaryError.message));

    try {
      const curious = await downloadCuriousApiProvider(job, info);
      const updated = getJob(id);
      updated.status = 'done';
      updated.provider = 'curiousapi';
      updated.title = curious.title;
      updated.thumbnail = curious.thumbnail;
      updated.duration = curious.duration;
      updated.uploader = curious.uploader;
      updated.sourcePlatform = curious.sourcePlatform;
      updated.filePath = curious.filePath;
      updated.fileSize = curious.fileSize;
      await upsertJob(updated);
      return;
    } catch (curiousError) {
      console.warn('[curiousapi] ' + truncate(curiousError.message));
    }

    const useExternal = String(process.env.VIDKRAKEN_ENABLED || '').toLowerCase() === 'true' &&
      Boolean(process.env.VIDKRAKEN_API_KEY) && job.type === 'video';
    if (useExternal) {
      try {
        const external = await downloadVidKrakenProvider(job, info);
        const updated = getJob(id);
        const metadata = external.metadata || {};
        updated.status = 'done';
        updated.provider = 'vidkraken';
        updated.title = metadata.title || info.title || 'Downloaded video';
        updated.thumbnail = metadata.thumbnail || info.thumbnail || null;
        updated.duration = metadata.duration ?? info.duration ?? null;
        updated.uploader = metadata.uploader || info.uploader || null;
        updated.sourcePlatform = metadata.extractor || info.extractor || null;
        updated.filePath = external.filePath;
        updated.fileSize = external.fileSize;
        await upsertJob(updated);
        return;
      } catch (externalError) {
        console.warn('[vidkraken] ' + truncate(externalError.message));
      }
    }

    throw primaryError;
  }
  const files = fs.readdirSync(DOWNLOAD_DIR).filter(file => file.startsWith(id));'''
if "downloadJobQueue.add(() => runYtDlp(args)" in s:
    s = s.replace(old_download, new_download, 1)
else:
    s = s.replace(old_download, new_download, 1)

p.write_text(s)
print('CuriousAPI fallback patch applied')


# The info endpoint must never become a dead-end when the primary metadata
# extractor fails. Return a safe generic video classification so the client can
# continue to /api/download, where the full provider fallback chain runs.
info_start = s.find("app.post('/api/info', requireAuth, rateLimit, async (req, res) => {")
quality_pos = s.find("\nconst { QUALITY_FORMATS", info_start)
if info_start < 0 or quality_pos < 0:
    quality_pos = s.find("\nconst QUALITY_FORMATS", info_start)
if info_start < 0 or quality_pos < 0:
    quality_pos = s.find("const QUALITY_FORMATS", info_start)
if info_start < 0 or quality_pos < 0:
    raise SystemExit('metadata route target not found')

info_end = quality_pos
fallback_info_route = r'''app.post('/api/info', requireAuth, rateLimit, async (req, res) => {
  const { url } = req.body || {};
  if (!url || !(await isSafeUrl(url))) {
    return res.status(400).json({ error: 'A valid, public http(s) URL is required.' });
  }

  try {
    const photo = await tryResolveTikTokPhoto(url);
    if (photo) {
      return res.json({
        title: photo.title,
        thumbnail: photo.thumbnail,
        duration: null,
        uploader: photo.uploader,
        extractor: 'TikTok Photo',
        contentType: 'photo',
        imageCount: photo.imageUrls.length,
        availableHeights: []
      });
    }

    try {
      const { stdout } = await runYtDlp(['-j', '--no-playlist', url]);
      const info = JSON.parse(stdout.trim().split('\n')[0]);
      const formats = Array.isArray(info.formats) ? info.formats : [];
      const hasVideo = Boolean(
        (info.vcodec && info.vcodec !== 'none') ||
        formats.some(format => format && (
          (format.vcodec && format.vcodec !== 'none') ||
          Number(format.height || 0) > 0 ||
          String(format.mime_type || format.mimeType || '').toLowerCase().startsWith('video/')
        ))
      );
      const hasAudio = Boolean(
        (info.acodec && info.acodec !== 'none') ||
        formats.some(format => format && format.acodec && format.acodec !== 'none')
      );
      const contentType = hasVideo ? 'video' : (hasAudio ? 'audio' : 'video');

      return res.json({
        title: info.title,
        thumbnail: info.thumbnail,
        duration: info.duration,
        uploader: info.uploader,
        extractor: info.extractor,
        contentType,
        previewUrl: contentType === 'video' ? getPreviewUrl(info) : null,
        availableHeights: [...new Set(formats.map(format => format.height).filter(Boolean))].sort((a, b) => b - a)
      });
    } catch (primaryError) {
      diagLog?.('metadata_degraded', {
        urlHost: safeHost(url),
        providerPlatform: providerRouter.classifyPlatform(url),
        primary: 'yt-dlp',
        detail: truncate(primaryError.message || String(primaryError), 900),
      });

      if (String(process.env.VIDKRAKEN_ENABLED || '').toLowerCase() === 'true' &&
          Boolean(process.env.VIDKRAKEN_API_KEY)) {
        try {
          const externalInfo = await vidkraken.getInfo(url);
          const metadata = externalInfo.metadata || {};
          if (metadata.title || metadata.thumbnail || metadata.duration || metadata.uploader || metadata.extractor) {
            return res.json({
              title: metadata.title || ('Media from ' + safeHost(url)),
              thumbnail: metadata.thumbnail || null,
              duration: metadata.duration ?? null,
              uploader: metadata.uploader || null,
              extractor: metadata.extractor || 'vidkraken',
              contentType: 'video',
              previewUrl: null,
              availableHeights: []
            });
          }
        } catch (externalInfoError) {
          console.warn('[vidkraken-info] ' + truncate(externalInfoError.message || String(externalInfoError)));
        }
      }

      return res.json({
        title: 'Media from ' + safeHost(url),
        thumbnail: null,
        duration: null,
        uploader: null,
        extractor: 'metadata-unavailable',
        contentType: 'video',
        previewUrl: null,
        availableHeights: []
      });
    }
  } catch (error) {
    return res.status(422).json({ error: 'Could not read that link.', detail: truncate(error.message) });
  }
});
'''
s = s[:info_start] + fallback_info_route + s[info_end:]

p.write_text(s)
print('Metadata failures now fall through to generic download handling')
