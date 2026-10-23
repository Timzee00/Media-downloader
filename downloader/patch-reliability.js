'use strict';
const fs = require('node:fs');
const path = require('node:path');
let s = fs.readFileSync('server.js', 'utf8');
function patch(oldText, newText, label) {
  if (!s.includes(oldText)) throw new Error(`Reliability build integration changed: ${label}`);
  s = s.replace(oldText, newText);
}
patch("const { v4: uuidv4 } = require('uuid');", "const { v4: uuidv4 } = require('uuid');\nconst reliability = require('./reliability-core');", 'imports');
patch('function runYtDlp(args) {', 'function runYtDlp(args, extra = {}) {', 'downloader entrypoint');
patch('meta: { urlHost: safeHost(url), operation },', 'meta: { urlHost: safeHost(url), operation, ...extra },', 'engine metadata');
patch("  return runExternalEngine('you-get', ['-o', DOWNLOAD_DIR, '-O', destinationPrefix, url], {",
  "  return runExternalEngine('you-get', ['-o', DOWNLOAD_DIR, '-O', reliability.fallbackOutputName(destinationPrefix), url], {", 'You-Get output');
patch('DOWNLOADER_ENGINE_TIMEOUT_MS || 180000','DOWNLOADER_ENGINE_TIMEOUT_MS || 900000','engine timeout');

const engineRecorder = `
    let progressBuffer = '';
    let lastProgressUpdate = 0;
    function trackProgress(chunk) {
      if (command !== 'yt-dlp' || !meta.jobId) return;
      progressBuffer = (progressBuffer + chunk.toString()).slice(-12000);
      const lines = progressBuffer.split(/[\\r\\n]+/);
      progressBuffer = lines.pop() || '';
      for (const line of lines) {
        const progress = reliability.parseProgress(line);
        if (!progress) continue;
        const now = Date.now();
        if (now - lastProgressUpdate < 1250 && progress.percent !== 100) continue;
        lastProgressUpdate = now;
        withJobs(jobs => {
          const job = jobs.find(item => item.id === meta.jobId);
          if (!job || job.status !== 'processing' || job.stage !== 'download') return;
          job.transfer = progress;
          if (progress.percent !== null) job.progress = Math.min(79, 35 + Math.round(progress.percent * 0.44));
          job.stageMessage = progress.percent === null ? 'Downloading media...' : 'Downloading media: ' + progress.percent + '% of source bytes.';
        }).catch(e => console.warn('[progress]', e.message));
      }
    }
`;
patch('    let finished = false;', '    let finished = false;' + engineRecorder, 'progress streaming');
patch("    proc.stdout.on('data', data => { stdout += data.toString(); });",
      "    proc.stdout.on('data', data => { stdout = (stdout + data.toString()).slice(-1500000); trackProgress(data); });", 'stdout processing');
patch("    proc.stderr.on('data', data => { stderr += data.toString(); });",
      "    proc.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-1500000); trackProgress(data); });", 'stderr processing');

async function newProcessJob(id) {
  const job = getJob(id); if (!job) return;
  await updateJobStage(id, 'validate', 10, 'Checking the link and available formats.');
  let photo = null;
  if (isTikTokHost(new URL(job.url).hostname)) {
    await updateJobStage(id, 'resolve', 18, 'Checking TikTok slideshow information.');
    photo = await tryResolveTikTokPhoto(job.url);
  }
  if (photo) {
    const result = job.type === 'audio'
      ? await downloadJobQueue.add(() => processTikTokPhotoAudioJob(job, id, photo), { urlHost: safeHost(job.url), operation: 'photo-audio', providerPlatform: 'tiktok' })
      : await downloadJobQueue.add(() => processTikTokPhotoJob(job, id, photo), { urlHost: safeHost(job.url), operation: 'photo-download', providerPlatform: 'tiktok' });
    const updated = getJob(id);
    Object.assign(updated, result, { status: 'done', type: job.type === 'audio' ? 'audio' : 'photo', stage: 'done', progress: 100, stageMessage: 'File is ready to save.' });
    await upsertJob(updated);
    return;
  }
  await updateJobStage(id, 'read_info', 25, 'Reading the media information.');
  let info = {};
  try {
    const { stdout } = await runYtDlp(['-j', '--no-playlist', job.url]);
    info = JSON.parse(stdout.trim().split('\n')[0]);
  } catch (error) { diagLog('metadata_optional_failure', { jobId: id, host: safeHost(job.url), detail: compactDetail(error.message, 260) }); }
  await updateJobStage(id, 'download', 35, 'Downloading media from its public source.');
  const outputTemplate = path.join(DOWNLOAD_DIR, `${id}.%(ext)s`);
  const args = job.type === 'audio'
    ? ['-x', '--audio-format', 'mp3', '--audio-quality', '0', '--no-playlist', ...reliability.progressArgs(), '-o', outputTemplate, job.url]
    : ['-f', QUALITY_FORMATS[job.quality] || QUALITY_FORMATS.best, '--merge-output-format', 'mp4', '--no-playlist', ...reliability.progressArgs(), '-o', outputTemplate, job.url];
  let engineResult;
  let alternativeProvider = null;
  try {
    engineResult = await downloadJobQueue.add(() => runYtDlp(args, { jobId: id }), {
      urlHost: safeHost(job.url), operation: 'download', providerPlatform: providerRouter.classifyPlatform(job.url)
    });
  } catch (primaryError) {
    // Explicit opt-in only: outside services can see submitted media links.
    if (job.type !== 'video') throw primaryError;
    if (process.env.CURIOUSAPI_ENABLED === 'true') {
      try {
        await downloadJobQueue.add(() => downloadCuriousApiProvider(job, info), { operation: 'external-fallback', providerPlatform: 'curiousapi' });
        alternativeProvider = 'curiousapi';
      } catch (error) { diagLog('curiousapi_failed', { jobId:id, detail:compactDetail(error.message,300) }); }
    }
    if (!alternativeProvider && process.env.VIDKRAKEN_ENABLED === 'true' && process.env.VIDKRAKEN_API_KEY) {
      try {
        await downloadJobQueue.add(() => downloadVidKrakenProvider(job, info), { operation: 'external-fallback', providerPlatform: 'vidkraken' });
        alternativeProvider = 'vidkraken';
      } catch (error) { diagLog('vidkraken_failed', { jobId:id, detail:compactDetail(error.message,300) }); }
    }
    if (!alternativeProvider) throw primaryError;
    engineResult = { stdout:'' };
  }
  await updateJobStage(id, 'process', 83, job.type === 'audio' ? 'Verifying and converting the audio file.' : 'Verifying the video file.');
  const outputs = String(engineResult.stdout || '').split(/[\r\n]/).map(line => line.trim()).filter(Boolean);
  const printedPath = outputs.reverse().find(line => line.startsWith(DOWNLOAD_DIR + path.sep)) || null;
  let file;
  try {
    file = await reliability.finalizeMedia({ dir: DOWNLOAD_DIR, id, type: job.type, printedPath, maxBytes: MAX_DOWNLOAD_BYTES });
  } catch (error) {
    diagLog('invalid_output', { jobId: id, code: error.code || 'MEDIA_INVALID', artifacts: error.artifacts || [], detail: compactDetail(error.message, 300) });
    throw error;
  }
  await updateJobStage(id, 'finalize', 96, 'Checking the completed file and preparing your download.');
  const updated = getJob(id);
  Object.assign(updated, {
    status: 'done', stage: 'done', progress: 100, stageMessage: 'File is ready to save.',
    title: info.title || 'Downloaded media', thumbnail: info.thumbnail || null,
    uploader: info.uploader || null, duration: info.duration || file.duration || null,
    sourcePlatform: info.extractor || providerRouter.classifyPlatform(job.url),
    filePath: file.filePath, fileSize: file.fileSize,
    provider: alternativeProvider || 'yt-dlp / you-get'
  });
  await upsertJob(updated);
}
const start = s.indexOf('async function processJob(id) {');
const end = s.indexOf('\n// ---------- Job/history ----------', start);
if (start < 0 || end < 0) throw new Error('Could not locate the complete job handler.');
s = s.slice(0, start) + newProcessJob.toString().replace('async function newProcessJob','async function processJob') + '\n' + s.slice(end);
fs.writeFileSync('server.js', s, 'utf8');

const h = 'public/index.html';
let html = fs.readFileSync(h, 'utf8');
if (!html.includes('id="transferStats"')) {
  function htmlPatch(oldText, newText, label) {
    if (!html.includes(oldText)) throw new Error(`Missing browser integration: ${label}`);
    html = html.replace(oldText, newText);
  }
  htmlPatch('<div class="progress-track">',
    '<div id="transferStats" class="transfer-stats" role="status" aria-live="off">Waiting for transfer metrics...</div>\n      <div class="progress-track">', 'transfer display');
  htmlPatch('<style>', `<style>
  .transfer-stats { margin: 12px 16px 15px; padding: 10px 12px; font-variant-numeric: tabular-nums; border-radius: 8px; background: rgba(14,165,233,.08); color: var(--text); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
  button, select, input, a { min-height: 42px; }
  :focus-visible { outline: 2px solid #22d3ee; outline-offset: 3px; }
  @media (prefers-reduced-motion:reduce) { *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; } }
`, 'accessible styling');
  const metricUI = `
function formatTransferBytes(bytes){if(bytes==null||!Number.isFinite(Number(bytes)))return '—';const b=Number(bytes);return b>=1048576?(b/1048576).toFixed(1)+' MB':b>=1024?(b/1024).toFixed(1)+' KB':b+' B';}
function updateTransferStats(job){
  const el=document.getElementById('transferStats');if(!el)return;
  const t=job.transfer;
  if(job.status==='done'){el.textContent='Verified file · '+formatTransferBytes(job.fileSize);return;}
  if(job.status==='failed'){el.textContent='The file was not completed. No misleading 100% status is shown.';return;}
  if(!t){el.textContent='Waiting for actual transfer metrics...';return;}
  const amount=formatTransferBytes(t.downloadedBytes)+' / '+formatTransferBytes(t.totalBytes);
  const speed=t.speedBytesPerSec==null?'speed unknown':formatTransferBytes(t.speedBytesPerSec)+'/s';
  const eta=t.etaSeconds==null?'ETA unknown':'ETA '+Math.ceil(t.etaSeconds)+'s';
  el.textContent=amount+' · '+speed+' · '+eta;
}
`;
  htmlPatch('function syncProgress(job,isPhoto){', metricUI + 'function syncProgress(job,isPhoto){\n  updateTransferStats(job);', 'progress page');
  fs.writeFileSync(h, html, 'utf8');
}
console.log('Reliability core integrated; generated server and UI patched.');
