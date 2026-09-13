from pathlib import Path

root = Path(__file__).resolve().parent
server = root / 'server.js'
html = root / 'public' / 'index.html'

s = server.read_text(encoding='utf-8')

old_response = "return res.json({ title: info.title, thumbnail: info.thumbnail, duration: info.duration, uploader: info.uploader, extractor: info.extractor, contentType: 'video', previewUrl: getPreviewUrl(info), availableHeights: [...new Set((info.formats || []).map(format => format.height).filter(Boolean))].sort((a, b) => b - a) });"
new_response = "const hasVideo = Boolean((info.vcodec && info.vcodec !== 'none') || (info.formats || []).some(format => format && format.vcodec && format.vcodec !== 'none')); const contentType = hasVideo ? 'video' : 'audio'; return res.json({ title: info.title, thumbnail: info.thumbnail, duration: info.duration, uploader: info.uploader, extractor: info.extractor, contentType, previewUrl: contentType === 'video' ? getPreviewUrl(info) : null, availableHeights: [...new Set((info.formats || []).map(format => format.height).filter(Boolean))].sort((a, b) => b - a) });"
if old_response not in s:
    raise SystemExit('Audio metadata response target not found')
s = s.replace(old_response, new_response, 1)
server.write_text(s, encoding='utf-8')

h = html.read_text(encoding='utf-8')

state_marker = "const typeSelect=$('#typeSelect'),qualitySelect=$('#qualitySelect'),urlInput=$('#urlInput'),detectedBox=$('#detectedBox');"
state_add = state_marker + "\nlet lastInfoData=null;"
if state_marker not in h:
    raise SystemExit('Frontend state marker not found')
h = h.replace(state_marker, state_add, 1)

old_change = "typeSelect.addEventListener('change',()=>{qualitySelect.style.display=typeSelect.value==='audio'?'none':'';});"
new_change = "typeSelect.addEventListener('change',()=>{qualitySelect.style.display=typeSelect.value==='audio'?'none':''; updatePreviewVisibility();});"
if old_change not in h:
    raise SystemExit('Type change handler not found')
h = h.replace(old_change, new_change, 1)

clear_old = "clearTimeout(infoDebounce); detectedContentType='video'; detectedBox.classList.add('hidden'); clearPreview();"
clear_new = "clearTimeout(infoDebounce); detectedContentType='video'; lastInfoData=null; detectedBox.classList.add('hidden'); clearPreview();"
if clear_old not in h:
    raise SystemExit('Preview reset target not found')
h = h.replace(clear_old, clear_new, 1)

old_info = "const data=await res.json();\n      detectedContentType=data.contentType||'video';"
new_info = "const data=await res.json();\n      lastInfoData=data;\n      detectedContentType=data.contentType||'video';"
if old_info not in h:
    raise SystemExit('Info assignment target not found')
h = h.replace(old_info, new_info, 1)

old_branch = "}else{\n        showPreview(data);\n        typeSelect.disabled=false;\n        qualitySelect.style.display=typeSelect.value==='audio'?'none':'';\n        if(data.availableHeights&&data.availableHeights.length)renderQualityOptions(data.availableHeights);\n      }"
new_branch = "}else if(detectedContentType==='audio'){\n        clearPreview();\n        typeSelect.value='audio'; typeSelect.disabled=true; qualitySelect.style.display='none';\n        detectedBox.textContent=`Audio detected — ${data.title||'Audio track'}. No video preview is needed.`;\n        detectedBox.classList.remove('hidden');\n      }else{\n        typeSelect.disabled=false;\n        qualitySelect.style.display=typeSelect.value==='audio'?'none':'';\n        updatePreviewVisibility();\n        if(data.availableHeights&&data.availableHeights.length)renderQualityOptions(data.availableHeights);\n      }"
if old_branch not in h:
    raise SystemExit('Frontend content-type branch not found')
h = h.replace(old_branch, new_branch, 1)

preview_marker = "function showPreview(data){ if(!data?.previewUrl){ clearPreview(); return; } previewTitle.textContent=data.title||'Video preview'; previewVideo.src=data.previewUrl; previewBox.classList.remove('hidden'); previewVideo.load(); }"
preview_add = preview_marker + "\nfunction updatePreviewVisibility(){ if(!lastInfoData || lastInfoData.contentType!=='video' || typeSelect.value!=='video'){ clearPreview(); return; } showPreview(lastInfoData); }"
if preview_marker not in h:
    raise SystemExit('showPreview function not found')
h = h.replace(preview_marker, preview_add, 1)

html.write_text(h, encoding='utf-8')
print('audio-only detection and preview rules patched')
