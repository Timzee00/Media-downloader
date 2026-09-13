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
if "let lastInfoData=null;" not in h:
    if state_marker not in h:
        raise SystemExit('Frontend state marker not found')
    h = h.replace(state_marker, state_marker + "\nlet lastInfoData=null;", 1)

old_change = "typeSelect.addEventListener('change',()=>{qualitySelect.style.display=typeSelect.value==='audio'?'none':'';});"
new_change = "typeSelect.addEventListener('change',()=>{qualitySelect.style.display=typeSelect.value==='audio'?'none':''; updatePreviewVisibility();});"
if old_change in h:
    h = h.replace(old_change, new_change, 1)

if "lastInfoData=null; detectedBox.classList.add('hidden'); clearPreview();" not in h:
    h = h.replace("clearTimeout(infoDebounce); detectedContentType='video'; detectedBox.classList.add('hidden'); clearPreview();", "clearTimeout(infoDebounce); detectedContentType='video'; lastInfoData=null; detectedBox.classList.add('hidden'); clearPreview();", 1)
else:
    h = h.replace("clearTimeout(infoDebounce); detectedContentType='video'; detectedBox.classList.add('hidden'); clearPreview();", "clearTimeout(infoDebounce); detectedContentType='video'; lastInfoData=null; detectedBox.classList.add('hidden'); clearPreview();", 1)

old_info = "const data=await res.json();\n      detectedContentType=data.contentType||'video';"
new_info = "const data=await res.json();\n      lastInfoData=data;\n      detectedContentType=data.contentType||'video';\n      if(detectedContentType==='audio'){\n        clearPreview();\n        typeSelect.value='audio';\n        typeSelect.disabled=true;\n        qualitySelect.style.display='none';\n        detectedBox.textContent=`Audio detected — ${data.title||'Audio track'}. No video preview is needed.`;\n        detectedBox.classList.remove('hidden');\n        return;\n      }"
if old_info in h:
    h = h.replace(old_info, new_info, 1)
else:
    raise SystemExit('Info assignment target not found')

if "function updatePreviewVisibility()" not in h:
    preview_end = " }"
    marker = "function showPreview(data){"
    start = h.find(marker)
    if start < 0:
        raise SystemExit('showPreview function not found')
    brace = h.find('{', start)
    depth = 0
    end = -1
    for i in range(brace, len(h)):
        if h[i] == '{': depth += 1
        elif h[i] == '}':
            depth -= 1
            if depth == 0:
                end = i + 1
                break
    if end < 0:
        raise SystemExit('Could not locate end of showPreview function')
    helper = "\nfunction updatePreviewVisibility(){ if(!lastInfoData || lastInfoData.contentType!=='video' || typeSelect.value!=='video'){ clearPreview(); return; } showPreview(lastInfoData); }"
    h = h[:end] + helper + h[end:]

# The TikTok photo branch already clears the preview. For normal video, explicitly
# render the thumbnail preview after the metadata response succeeds.
video_branch_marker = "}else{\n        typeSelect.disabled=false;"
if video_branch_marker in h:
    h = h.replace(video_branch_marker, "}else{\n        showPreview(data);\n        typeSelect.disabled=false;", 1)

html.write_text(h, encoding='utf-8')
print('audio-only detection and thumbnail preview rules patched')
