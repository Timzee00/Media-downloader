from pathlib import Path
p = Path('server.js')
s = p.read_text()
needle = "const { v4: uuidv4 } = require('uuid');\n"
if "./providers/vidkraken" not in s:
    if needle not in s: raise SystemExit('import target not found')
    s = s.replace(needle, needle + "const vidkraken = require('./providers/vidkraken');\n", 1)
needle = "// ---------- Download ----------\n"
if needle not in s: raise SystemExit('download marker not found')
helper = r'''async function downloadExternalProvider(job) {
  if (job.type !== 'video') throw new Error('External provider supports video jobs only.');
  const format = job.quality === 'best' ? '1080' : String(job.quality).replace(/p$/i, '');
  const submitted = await vidkraken.submitDownload(job.url, format);
  const completed = await vidkraken.waitForDownload(submitted.jobId);
  const response = await fetch(completed.downloadUrl, { redirect: 'follow' });
  if (!response.ok) throw new Error(`External provider download returned HTTP ${response.status}.`);
  const contentType = response.headers.get('content-type') || 'video/mp4';
  const extension = contentType.includes('webm') ? 'webm' : 'mp4';
  const filePath = path.join(DOWNLOAD_DIR, `${job.id}.${extension}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(filePath, buffer);
  return { filePath: path.basename(filePath), fileSize: buffer.length };
}

'''
s = s.replace(needle, helper + needle, 1)
marker = "  let info = {};\n"
if marker not in s: raise SystemExit('process info marker not found')
insert = r'''  const useExternal = String(process.env.VIDKRAKEN_ENABLED || '').toLowerCase() === 'true' && Boolean(process.env.VIDKRAKEN_API_KEY) && job.type === 'video';
  if (useExternal) {
    try {
      const external = await downloadExternalProvider(job);
      const updated = getJob(id);
      updated.status = 'done';
      updated.provider = 'external';
      updated.title = info.title || 'Downloaded video';
      updated.thumbnail = info.thumbnail || null;
      updated.duration = info.duration || null;
      updated.sourcePlatform = info.extractor || null;
      updated.filePath = external.filePath;
      updated.fileSize = external.fileSize;
      await upsertJob(updated);
      return;
    } catch (error) {
      console.warn(`[external-provider] ${truncate(error.message)}`);
    }
  }
'''
s = s.replace(marker, marker + insert, 1)
p.write_text(s)
print('External provider patch applied')
