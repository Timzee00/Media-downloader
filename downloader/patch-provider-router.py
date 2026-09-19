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
elif "./providers/vidkraken" not in s:
    s = s.replace(import_needle, import_needle + "const vidkraken = require('./providers/vidkraken');\n", 1)

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

old_external = '''  const useExternal = String(process.env.VIDKRAKEN_ENABLED || '').toLowerCase() === 'true' && Boolean(process.env.VIDKRAKEN_API_KEY) && job.type === 'video';
  if (useExternal) {
    try {
      const external = await downloadExternalProvider(job);
      const updated = getJob(id);
      const metadata = external.metadata || {};
      updated.status = 'done';
      updated.provider = 'external';
      updated.title = metadata.title || 'Downloaded video';
      updated.thumbnail = metadata.thumbnail || null;
      updated.duration = metadata.duration || null;
      updated.uploader = metadata.uploader || null;
      updated.sourcePlatform = metadata.extractor || null;
      updated.filePath = external.filePath;
      updated.fileSize = external.fileSize;
      await upsertJob(updated);
      return;
    } catch (error) {
      console.warn(`[external-provider] ${truncate(error.message)}`);
    }
  }
'''
if old_external not in s:
    raise SystemExit('old external-first block not found')
s = s.replace(old_external, '', 1)

old_download = "  await runYtDlp(args);\n  const files = fs.readdirSync(DOWNLOAD_DIR).filter(file => file.startsWith(id));"
new_download = '''  try {
    await runYtDlp(args);
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
if old_download not in s:
    raise SystemExit('yt-dlp download target not found')
s = s.replace(old_download, new_download, 1)

p.write_text(s)
print('CuriousAPI fallback patch applied')
