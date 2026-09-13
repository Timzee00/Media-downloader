from pathlib import Path

root = Path(__file__).resolve().parent
server = root / 'server.js'
html = root / 'public' / 'index.html'

s = server.read_text(encoding='utf-8')

helper_marker = "function getPreviewUrl(info) {"
helper = r'''function getPreviewUrl(info) {
  const isPlayable = format => format && format.url && format.vcodec && format.vcodec !== 'none' && format.acodec && format.acodec !== 'none';
  if (isPlayable(info)) return info.url;
  const formats = Array.isArray(info.formats) ? info.formats.filter(isPlayable) : [];
  formats.sort((a, b) => {
    const ah = Number(a.height || 0), bh = Number(b.height || 0);
    if (bh !== ah) return bh - ah;
    return Number(b.tbr || 0) - Number(a.tbr || 0);
  });
  return formats[0]?.url || null;
}

'''
if helper_marker not in s:
    needle = "const QUALITY_FORMATS = {"
    if needle not in s:
        raise SystemExit('QUALITY_FORMATS target not found')
    s = s.replace(needle, helper + needle, 1)

old = "return res.json({ title: info.title, thumbnail: info.thumbnail, duration: info.duration, uploader: info.uploader, extractor: info.extractor, contentType: 'video', availableHeights: [...new Set((info.formats || []).map(format => format.height).filter(Boolean))].sort((a, b) => b - a) });"
new = "return res.json({ title: info.title, thumbnail: info.thumbnail, duration: info.duration, uploader: info.uploader, extractor: info.extractor, contentType: 'video', previewUrl: getPreviewUrl(info), availableHeights: [...new Set((info.formats || []).map(format => format.height).filter(Boolean))].sort((a, b) => b - a) });"
if old not in s:
    raise SystemExit('Metadata response target not found')
s = s.replace(old, new, 1)
server.write_text(s, encoding='utf-8')

h = html.read_text(encoding='utf-8')

css_marker = "  .detected { margin-top:10px; padding:9px 10px; border:1px solid var(--border); border-radius:8px; font-size:12px; color:var(--muted); }"
css_add = css_marker + "\n  .preview-box { margin-top:14px; border:1px solid var(--border); border-radius:10px; overflow:hidden; background:#080d19; }\n  .preview-box video { display:block; width:100%; max-height:360px; background:#000; }\n  .preview-meta { padding:9px 11px; font-size:11px; color:var(--muted); }\n  .preview-box .preview-title { color:var(--text); font-size:12px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }"
if css_marker not in h:
    raise SystemExit('Preview CSS marker not found')
h = h.replace(css_marker, css_add, 1)

html_marker = '<div id="detectedBox" class="detected hidden"></div>'
html_add = html_marker + '\n    <div id="previewBox" class="preview-box hidden"><video id="previewVideo" controls playsinline preload="metadata" referrerpolicy="no-referrer"></video><div class="preview-meta"><div class="preview-title" id="previewTitle">Video preview</div><div>Preview only — your file is not downloaded until you press Download.</div></div></div>'
if html_marker not in h:
    raise SystemExit('Preview HTML marker not found')
h = h.replace(html_marker, html_add, 1)

js_marker = "const typeSelect=$('#typeSelect'),qualitySelect=$('#qualitySelect'),urlInput=$('#urlInput'),detectedBox=$('#detectedBox');"
js_add = js_marker + "\nconst previewBox=$('#previewBox'),previewVideo=$('#previewVideo'),previewTitle=$('#previewTitle');\nfunction clearPreview(){ previewVideo.pause(); previewVideo.removeAttribute('src'); previewVideo.load(); previewBox.classList.add('hidden'); previewTitle.textContent='Video preview'; }\nfunction showPreview(data){ if(!data?.previewUrl){ clearPreview(); return; } previewTitle.textContent=data.title||'Video preview'; previewVideo.src=data.previewUrl; previewBox.classList.remove('hidden'); previewVideo.load(); }"
if js_marker not in h:
    raise SystemExit('Preview JS marker not found')
h = h.replace(js_marker, js_add, 1)

h = h.replace("clearTimeout(infoDebounce); detectedContentType='video'; detectedBox.classList.add('hidden');", "clearTimeout(infoDebounce); detectedContentType='video'; detectedBox.classList.add('hidden'); clearPreview();", 1)
h = h.replace("if(detectedContentType==='photo'){", "if(detectedContentType==='photo'){\n        clearPreview();", 1)
h = h.replace("}else{\n        typeSelect.disabled=false;", "}else{\n        showPreview(data);\n        typeSelect.disabled=false;", 1)

html.write_text(h, encoding='utf-8')
print('preview feature patched')
