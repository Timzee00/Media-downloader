const API_BASE = 'https://vidkraken.com/api/v2';
const POLL_MS = Math.max(1000, Number(process.env.VIDKRAKEN_POLL_MS || 3000));
const TIMEOUT_MS = Math.max(10000, Number(process.env.VIDKRAKEN_TIMEOUT_MS || 120000));
function key() { const value = String(process.env.VIDKRAKEN_API_KEY || '').trim(); if (!value) throw new Error('VIDKRAKEN_API_KEY is not configured.'); return value; }
async function request(pathname, options = {}) { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 30000); try { const response = await fetch(`${API_BASE}${pathname}`, { ...options, signal: controller.signal, headers: { Authorization: `Bearer ${key()}`, Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } }); const text = await response.text(); let data = {}; try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text || 'Invalid provider response.' }; } if (!response.ok) throw new Error(String(data?.error || data?.message || `Provider returned HTTP ${response.status}.`)); return data; } finally { clearTimeout(timer); } }
function statusOf(data) { const value = String(data?.status || data?.state || '').toLowerCase(); if (['completed','complete','done','success','succeeded'].includes(value)) return 'completed'; if (['failed','failure','error','cancelled','canceled'].includes(value)) return 'failed'; return 'processing'; }
function urlOf(data) { return data?.downloadUrl || data?.download_url || data?.url || data?.result?.downloadUrl || data?.result?.download_url || data?.result?.url || null; }
function metadataOf(data) {
  return {
    title: data?.title || data?.metadata?.title || data?.result?.title || null,
    thumbnail: data?.thumbnail || data?.thumbnailUrl || data?.thumbnail_url || data?.metadata?.thumbnail || data?.metadata?.thumbnailUrl || data?.metadata?.thumbnail_url || data?.result?.thumbnail || data?.result?.thumbnailUrl || data?.result?.thumbnail_url || null,
    duration: data?.duration ?? data?.metadata?.duration ?? data?.result?.duration ?? null,
    uploader: data?.uploader || data?.channel || data?.author || data?.metadata?.uploader || data?.result?.uploader || null,
    extractor: data?.extractor || data?.platform || data?.source || data?.metadata?.extractor || data?.result?.extractor || null,
  };
}
async function submitDownload(url, format = 'best') { const data = await request('/download', { method: 'POST', body: JSON.stringify({ url, format }) }); const jobId = data?.jobId || data?.job_id || data?.id; if (!jobId) throw new Error('External provider did not return a job ID.'); return { jobId: String(jobId), metadata: metadataOf(data) }; }
async function getInfo(url) { const data = await request('/info', { method: 'POST', body: JSON.stringify({ url }) }); return { metadata: metadataOf(data), raw: data }; }
async function getDownloadStatus(jobId) { const data = await request(`/download/${encodeURIComponent(jobId)}`); const status = statusOf(data); if (status === 'failed') throw new Error(String(data?.error || data?.message || 'External provider download failed.')); return { status, downloadUrl: urlOf(data), metadata: metadataOf(data) }; }
async function waitForDownload(jobId) { const deadline = Date.now() + TIMEOUT_MS; let latestMetadata = {}; while (Date.now() < deadline) { const result = await getDownloadStatus(jobId); latestMetadata = { ...latestMetadata, ...Object.fromEntries(Object.entries(result.metadata || {}).filter(([, value]) => value !== null && value !== undefined && value !== '')) }; if (result.status === 'completed') { if (!result.downloadUrl) throw new Error('External provider completed without a download URL.'); return { ...result, metadata: latestMetadata }; } await new Promise(resolve => setTimeout(resolve, POLL_MS)); } throw new Error('External provider job timed out.'); }
module.exports = { submitDownload, getInfo, getDownloadStatus, waitForDownload };