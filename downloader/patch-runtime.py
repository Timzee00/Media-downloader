from pathlib import Path

ROOT = Path(__file__).resolve().parent
SERVER = ROOT / 'server.js'
HTML = ROOT / 'public' / 'index.html'


def replace_once(text, old, new, label):
    if old not in text:
        raise RuntimeError(f'Patch target not found: {label}')
    return text.replace(old, new, 1)


# ---------------- Server: real job stages ----------------
s = SERVER.read_text(encoding='utf-8')

if 'function updateJobStage(' not in s:
    s = replace_once(
        s,
        "function getJob(id) { return readJobs().find(job => job.id === id); }",
        "function getJob(id) { return readJobs().find(job => job.id === id); }\nfunction updateJobStage(id, stage, progress, stageMessage) { return withJobs(jobs => { const job = jobs.find(item => item.id === id); if (!job) return; job.stage = stage; job.progress = progress; job.stageMessage = stageMessage; }); }",
        'updateJobStage helper',
    )

s = replace_once(
    s,
    "const job = { id, url, quality, type, status: 'processing', title: null, thumbnail: null, filePath: null, fileSize: null, error: null, createdAt: new Date().toISOString() };",
    "const job = { id, url, quality, type, status: 'processing', stage: 'validate', progress: 5, stageMessage: 'Checking the URL and security rules.', title: null, thumbnail: null, filePath: null, fileSize: null, error: null, createdAt: new Date().toISOString() };",
    'initial job stage',
)

s = replace_once(
    s,
    "processJob(id).catch(async error => { const current = getJob(id); if (!current) return; current.status = 'failed'; current.error = truncate(error.message); await upsertJob(current); }).finally(() => { activeJobCount--; });",
    "processJob(id).catch(async error => { const current = getJob(id); if (!current) return; current.status = 'failed'; current.stage = current.stage || 'validate'; current.progress = Math.min(Number(current.progress || 5), 95); current.stageMessage = 'The download could not be completed.'; current.error = truncate(error.message); await upsertJob(current); }).finally(() => { activeJobCount--; });",
    'failure stage handling',
)

s = replace_once(
    s,
    "async function processTikTokPhotoJob(job, id, photo) { const imageFiles = []; const prefix = path.join(DOWNLOAD_DIR, `${id}-photo-`); try { for (let index = 0; index < photo.imageUrls.length; index++) {",
    "async function processTikTokPhotoJob(job, id, photo) { const imageFiles = []; const prefix = path.join(DOWNLOAD_DIR, `${id}-photo-`); try { await updateJobStage(id, 'download', 30, `Downloading ${photo.imageUrls.length} image(s) from the TikTok slideshow.`); for (let index = 0; index < photo.imageUrls.length; index++) {",
    'photo download stage start',
)

s = replace_once(
    s,
    "await downloadTikTokAsset(assetUrl, filePath, photo.finalUrl); imageFiles.push(filePath); } if (!imageFiles.length) throw new Error('No images were downloaded from the TikTok post.'); const zipPath = path.join(DOWNLOAD_DIR, `${id}-tiktok-photos.zip`); await createZipArchive(imageFiles, zipPath);",
    "await downloadTikTokAsset(assetUrl, filePath, photo.finalUrl); imageFiles.push(filePath); const progress = 30 + Math.round(((index + 1) / photo.imageUrls.length) * 45); await updateJobStage(id, 'download', progress, `Downloaded ${index + 1} of ${photo.imageUrls.length} image(s).`); } if (!imageFiles.length) throw new Error('No images were downloaded from the TikTok post.'); const zipPath = path.join(DOWNLOAD_DIR, `${id}-tiktok-photos.zip`); await updateJobStage(id, 'process', 82, 'Packaging the downloaded images into a ZIP archive.'); await createZipArchive(imageFiles, zipPath); await updateJobStage(id, 'finalize', 95, 'Checking the ZIP archive and preparing your download.');",
    'photo download/zip stages',
)

# Replace the existing processJob body with a stage-aware version.
start = s.index('async function processJob(id) {')
end = s.index('\n// ---------- Job/history ----------', start)
new_process = '''async function processJob(id) {\n  const job = getJob(id); if (!job) return;\n  await updateJobStage(id, 'validate', 10, 'URL accepted. Preparing the download.');\n  await updateJobStage(id, 'resolve', 18, 'Checking whether this is a TikTok photo slideshow.');\n  const photo = await tryResolveTikTokPhoto(job.url);\n  if (photo) {\n    if (job.type === 'audio') throw new Error('TikTok photo posts contain images, so audio-only download is not available.');\n    const result = await processTikTokPhotoJob(job, id, photo);\n    const updated = getJob(id);\n    Object.assign(updated, result, { status: 'done', type: 'photo', stage: 'done', progress: 100, stageMessage: 'Download complete.' });\n    await upsertJob(updated);\n    return;\n  }\n\n  await updateJobStage(id, 'read_info', 25, 'Reading the title, formats and available media information.');\n  let info = {};\n  try { const { stdout } = await runYtDlp(['-j', '--no-playlist', job.url]); info = JSON.parse(stdout.trim().split('\\n')[0]); } catch {}\n  await updateJobStage(id, 'download', 35, job.type === 'audio' ? 'Downloading the audio stream.' : 'Downloading the selected video and audio streams.');\n  const outputTemplate = path.join(DOWNLOAD_DIR, `${id}.%(ext)s`);\n  let args;\n  if (job.type === 'audio') {\n    args = ['-x', '--audio-format', 'mp3', '--audio-quality', '0', '--no-playlist', '-o', outputTemplate, job.url];\n  } else {\n    const format = QUALITY_FORMATS[job.quality] || QUALITY_FORMATS.best;\n    args = ['-f', format, '--merge-output-format', 'mp4', '--no-playlist', '-o', outputTemplate, job.url];\n  }\n  await runYtDlp(args);\n  await updateJobStage(id, 'process', 82, job.type === 'audio' ? 'Converting the downloaded audio to MP3.' : 'Combining streams and preparing the final video.');\n  const files = fs.readdirSync(DOWNLOAD_DIR).filter(file => file.startsWith(id));\n  if (!files.length) throw new Error('Download finished but no output file was found.');\n  const finalFile = files[0];\n  const fullPath = path.join(DOWNLOAD_DIR, finalFile);\n  await updateJobStage(id, 'finalize', 95, 'Checking the finished file and preparing your download.');\n  const updated = getJob(id);\n  updated.status = 'done';\n  updated.stage = 'done';\n  updated.progress = 100;\n  updated.stageMessage = 'Download complete.';\n  updated.title = info.title || 'Untitled';\n  updated.thumbnail = info.thumbnail || null;\n  updated.duration = info.duration || null;\n  updated.sourcePlatform = info.extractor || null;\n  updated.filePath = finalFile;\n  updated.fileSize = fs.statSync(fullPath).size;\n  await upsertJob(updated);\n}\n'''
s = s[:start] + new_process + s[end:]
SERVER.write_text(s, encoding='utf-8')


# ---------------- Frontend: server-driven progress ----------------
h = HTML.read_text(encoding='utf-8')
start_marker = "const progressPanel=$('#progressPanel'),progressList=$('#stageList'),progressFill=$('#progressFill'),progressTitle=$('#progressTitle'),progressDetail=$('#progressDetail'),progressOrb=$('#progressOrb');"
end_marker = "$('#downloadBtn').addEventListener('click',async()=>{"
start = h.index(start_marker)
end = h.index(end_marker, start)
new_ui = '''const progressPanel=$('#progressPanel'),progressList=$('#stageList'),progressFill=$('#progressFill'),progressTitle=$('#progressTitle'),progressDetail=$('#progressDetail'),progressOrb=$('#progressOrb');\nfunction buildStages(isPhoto){\n  return isPhoto ? [\n    ['validate','Validate link','Checking the URL and security rules.'],\n    ['resolve','Resolve TikTok post','Checking and resolving the TikTok photo post.'],\n    ['download','Fetch images','Downloading each image from the slideshow.'],\n    ['process','Build ZIP archive','Packaging the images into one downloadable file.'],\n    ['finalize','Finalize','Checking the archive and preparing your download.']\n  ] : [\n    ['validate','Validate link','Checking the URL and security rules.'],\n    ['read_info','Read media information','Finding the title, formats and available quality.'],\n    ['download','Download media','Fetching the selected video or audio stream.'],\n    ['process','Process media','Combining streams or converting to the requested format.'],\n    ['finalize','Finalize','Checking the file and preparing your download.']\n  ];\n}\nfunction startProgress(isPhoto){\n  const stages=buildStages(isPhoto);\n  progressPanel.classList.remove('hidden','complete','error');\n  progressOrb.classList.remove('done');\n  progressList.innerHTML=stages.map((s,i)=>`<div class="stage" data-stage="${s[0]}"><div class="stage-marker">${i+1}</div><div><div class="stage-name">${s[1]}</div><div class="stage-detail">${s[2]}</div></div><div class="stage-time" data-time="${i}"></div></div>`).join('');\n  syncProgress({stage:'validate',progress:5,stageMessage:stages[0][2]},isPhoto);\n}\nfunction syncProgress(job,isPhoto){\n  const stages=[...progressList.querySelectorAll('.stage')];\n  const current=job.stage||'validate';\n  const currentIndex=Math.max(0,stages.findIndex(s=>s.dataset.stage===current));\n  const done=job.status==='done';\n  const failed=job.status==='failed';\n  stages.forEach((el,i)=>{\n    el.classList.toggle('done',done||(!failed&&i<currentIndex));\n    el.classList.toggle('active',!done&&!failed&&i===currentIndex);\n    el.classList.remove('failed');\n  });\n  if(failed){stages.forEach((el,i)=>el.classList.toggle('done',i<currentIndex));if(stages[currentIndex])stages[currentIndex].classList.add('failed');}\n  const progress=Math.max(5,Math.min(100,Number(job.progress)||5));\n  progressFill.style.width=`${progress}%`;\n  if(done){progressTitle.textContent='Download ready';progressDetail.textContent=job.stageMessage||'Everything is finished. Your file is ready to save.';progressPanel.classList.add('complete');progressOrb.classList.add('done');}\n  else if(failed){progressTitle.textContent='Download failed';progressDetail.textContent=job.error||job.stageMessage||'The server could not complete the download.';progressPanel.classList.add('error');}\n  else {const active=stages[currentIndex];progressTitle.textContent=active?.querySelector('.stage-name')?.textContent||'Processing';progressDetail.textContent=job.stageMessage||active?.querySelector('.stage-detail')?.textContent||'Working...';}\n}\nfunction finishProgress(success,errorMessage){\n  const stages=[...progressList.querySelectorAll('.stage')];\n  if(success){stages.forEach(s=>{s.classList.remove('active','failed');s.classList.add('done');});progressTitle.textContent='Download ready';progressDetail.textContent='Everything is finished. Your file is ready to save.';progressFill.style.width='100%';progressPanel.classList.add('complete');progressOrb.classList.add('done');}\n  else {const active=stages.find(s=>s.classList.contains('active'))||stages[0];stages.forEach(s=>s.classList.remove('active'));if(active)active.classList.add('failed');progressTitle.textContent='Download failed';progressDetail.textContent=errorMessage||'The server could not complete the download.';progressPanel.classList.add('error');}\n}\n\n'''
h = h[:start] + new_ui + h[end:]

h = replace_once(
    h,
    "const job=await statusRes.json();consecutiveFailures=0;\n      if(job.status==='done'){",
    "const job=await statusRes.json();consecutiveFailures=0; syncProgress(job,isPhoto);\n      if(job.status==='done'){",
    'status polling stage sync',
)
HTML.write_text(h, encoding='utf-8')

print('runtime patch applied')
