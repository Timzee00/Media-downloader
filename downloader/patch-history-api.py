from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent
HTML = ROOT / 'public' / 'index.html'
SERVER = ROOT / 'server.js'

h = HTML.read_text(encoding='utf-8')
s = SERVER.read_text(encoding='utf-8')

# ---------------- Persistent browser history ----------------
# Keep the server history endpoint, but cache compact history metadata in the
# browser so it survives page/tab closes and is shared by other tabs on the
# same device/origin. The storage event keeps open tabs synchronized.
if 'MEDIA_DOWNLOADER_HISTORY_V1' not in h:
    marker = "const panel = $('#historyPanel');"
    if marker not in h:
        raise SystemExit('History panel marker not found')

    persistence = r'''const HISTORY_STORAGE_KEY = 'MEDIA_DOWNLOADER_HISTORY_V1';
const HISTORY_MAX_ITEMS = 100;

function readHistoryCache(){
  try{
    const raw=localStorage.getItem(HISTORY_STORAGE_KEY);
    const items=raw?JSON.parse(raw):[];
    return Array.isArray(items)?items:[];
  }catch{return [];}
}
function normalizeHistoryItem(item){
  if(!item || !item.id) return null;
  return {
    id:String(item.id),
    title:item.title||'Untitled',
    thumbnail:item.thumbnail||null,
    sourcePlatform:item.sourcePlatform||item.extractor||'Media',
    type:item.type==='audio'?'audio':'video',
    fileSize:Number(item.fileSize)||0,
    duration:item.duration||null,
    createdAt:item.createdAt||new Date().toISOString()
  };
}
function writeHistoryCache(items){
  try{
    const compact=items.map(normalizeHistoryItem).filter(Boolean).slice(0,HISTORY_MAX_ITEMS);
    localStorage.setItem(HISTORY_STORAGE_KEY,JSON.stringify(compact));
  }catch{}
}
function mergeHistoryItems(serverItems){
  const cached=readHistoryCache();
  const incoming=Array.isArray(serverItems)?serverItems:[];
  const byId=new Map();
  [...cached,...incoming].forEach(item=>{
    const normalized=normalizeHistoryItem(item);
    if(normalized) byId.set(normalized.id,{...(byId.get(normalized.id)||{}),...normalized});
  });
  const merged=[...byId.values()].sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
  writeHistoryCache(merged);
  return readHistoryCache();
}
function removeHistoryFromCache(id){
  writeHistoryCache(readHistoryCache().filter(item=>String(item.id)!==String(id)));
}
function renderHistoryItems(items){
  const list=$('#historyList');
  if(!items.length){list.innerHTML='<div class="empty">No downloads yet.</div>';return;}
  list.innerHTML=items.map(item=>`
    <div class="history-item">
      <img src="${item.thumbnail||''}" onerror="this.style.visibility='hidden'">
      <div class="meta">
        <div class="title">${escapeHtml(item.title)}</div>
        <div class="sub">${escapeHtml(item.sourcePlatform||'')} · ${item.type==='audio'?'MP3':'Video'} · ${formatSize(item.fileSize)}</div>
        <div class="actions">
          <a href="/files/${encodeURIComponent(item.id)}" download>Save</a>
          <button onclick="deleteItem('${String(item.id).replace(/'/g,"\\'")}')">Delete</button>
        </div>
      </div>
    </div>
  `).join('');
}

window.addEventListener('storage',event=>{
  if(event.key===HISTORY_STORAGE_KEY) renderHistoryItems(readHistoryCache());
});
'''
    h=h.replace(marker,persistence+"\n"+marker,1)

if 'async function loadHistory(){' not in h:
    raise SystemExit('loadHistory function not found')
start=h.index('async function loadHistory(){')
brace=h.index('{',start)
depth=0
end=None
for i in range(brace,len(h)):
    if h[i]=='{': depth+=1
    elif h[i]=='}':
        depth-=1
        if depth==0:
            end=i+1
            break
if end is None:
    raise SystemExit('Could not locate loadHistory end')

new_load=r'''async function loadHistory(){
  const cached=readHistoryCache();
  if(cached.length) renderHistoryItems(cached);
  try{
    const res=await fetch('/api/history');
    if(!res.ok) throw new Error('History request failed');
    const items=await res.json();
    const merged=mergeHistoryItems(items);
    renderHistoryItems(merged);
  }catch{
    renderHistoryItems(readHistoryCache());
  }
}'''
h=h[:start]+new_load+h[end:]

old_delete="""async function deleteItem(id) {
  await fetch(`/api/history/${id}`, { method: 'DELETE' });
  loadHistory();
}"""
new_delete="""async function deleteItem(id) {
  removeHistoryFromCache(id);
  renderHistoryItems(readHistoryCache());
  try { await fetch(`/api/history/${encodeURIComponent(id)}`, { method: 'DELETE' }); } catch {}
  loadHistory();
}"""
if old_delete in h:
    h=h.replace(old_delete,new_delete,1)
else:
    if 'async function deleteItem(id)' not in h:
        raise SystemExit('deleteItem function not found')
    ds=h.index('async function deleteItem(id)')
    db=h.index('{',ds); depth=0; de=None
    for i in range(db,len(h)):
        if h[i]=='{': depth+=1
        elif h[i]=='}':
            depth-=1
            if depth==0: de=i+1; break
    if de is None: raise SystemExit('Could not locate deleteItem end')
    h=h[:ds]+new_delete+h[de:]
HTML.write_text(h,encoding='utf-8')

# ---------------- API-key access without breaking the website ----------------
needle="function requireAuth(req, res, next) {"
if needle not in s:
    raise SystemExit('requireAuth function not found')
old="function requireAuth(req, res, next) { if (!ACCESS_PASSWORD) return next(); if (req.cookies?.session === SESSION_TOKEN) return next(); return res.status(401).json({ error: 'Not authenticated.' }); }"
new="function requireAuth(req, res, next) { const configuredApiKey = process.env.API_KEY || ''; if (configuredApiKey && req.get('x-api-key') === configuredApiKey) return next(); if (!ACCESS_PASSWORD) return next(); if (req.cookies?.session === SESSION_TOKEN) return next(); return res.status(401).json({ error: 'Not authenticated.' }); }"
if old in s:
    s=s.replace(old,new,1)
else:
    pattern=re.compile(r"function requireAuth\(req, res, next\) \{.*?\n?\}",re.S)
    match=pattern.search(s)
    if not match:
        raise SystemExit('Could not safely locate requireAuth implementation')
    replacement="function requireAuth(req, res, next) { const configuredApiKey = process.env.API_KEY || ''; if (configuredApiKey && req.get('x-api-key') === configuredApiKey) return next(); if (!ACCESS_PASSWORD) return next(); if (req.cookies?.session === SESSION_TOKEN) return next(); return res.status(401).json({ error: 'Not authenticated.' }); }"
    s=s[:match.start()]+replacement+s[match.end():]

if "app.get('/api/v1'" not in s:
    insert_marker="// ---------- URL validation / SSRF protection ----------"
    if insert_marker not in s:
        raise SystemExit('API insertion marker not found')
    api_block="""// ---------- Public API discovery ----------
app.get('/api/v1', (req, res) => res.json({
  name: 'Media Downloader API',
  version: '1',
  endpoints: {
    info: 'POST /api/info',
    download: 'POST /api/download',
    status: 'GET /api/status/:id',
    history: 'GET /api/history'
  },
  authentication: process.env.API_KEY ? 'X-API-Key' : 'none'
}));

"""
    s=s.replace(insert_marker,api_block+insert_marker,1)
SERVER.write_text(s,encoding='utf-8')
print('persistent browser history and API access patched')
