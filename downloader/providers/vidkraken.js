const API_BASE = 'https://vidkraken.com/api/v2';
const POLL_MS = Math.max(1000, Number(process.env.VIDKRAKEN_POLL_MS || 3000));
const TIMEOUT_MS = Math.max(10000, Number(process.env.VIDKRAKEN_TIMEOUT_MS || 120000));

function getApiKey() {
  const key = String(process.env.VIDKRAKEN_API_KEY || '').trim();
  if (!key) throw new Error('VIDKRAKEN_API_KEY is not configured.');
  return key;
}

async function request(pathname, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(`${API_BASE}${pathname}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${getApiKey()}`,
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text || 'Invalid provider response.' }; }
    if (!response.ok) {
      const message = data?.error || data?.message || `Provider returned HTTP ${response.status}.`;
      const error = new Error(String(message));
      error.status = response.status;
      error.providerResponse = data;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeStatus(data) {
  const status = String(data?.status || data?.state || '').toLowerCase();
  if (['completed', 'complete', 'done', 'success', 'succeeded'].includes(status)) return 'completed';
  if (['failed', 'failure', 'error', 'cancelled', 'canceled'].includes(status)) return 'failed';
  return 'processing';
}

function extractDownloadUrl(data) {
  return data?.downloadUrl || data?.download_url || data?.url || data?.result?.downloadUrl || data?.result?.download_url || data?.result?.url || null;
}

async function submitDownload(url, format = 'best') {
  const data = await request('/download', {
    method: 'POST',
    body: JSON.stringify({ url, format }),
  });
  const jobId = data?.jobId || data?.job_id || data?.id;
  if (!jobId) throw new Error('External provider did not return a job ID.');
  return { jobId: String(jobId), raw: data };
}

async function getDownloadStatus(jobId) {
  const data = await request(`/download/${encodeURIComponent(jobId)}`);
  const status = normalizeStatus(data);
  const downloadUrl = extractDownloadUrl(data);
  if (status === 'failed') {
    throw new Error(String(data?.error || data?.message || 'External provider download failed.'));
  }
  return { status, downloadUrl, raw: data };
}

async function waitForDownload(jobId, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await getDownloadStatus(jobId);
    if (result.status === 'completed') {
      if (!result.downloadUrl) throw new Error('External provider completed the job without a download URL.');
      return result;
    }
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
  throw new Error('External provider job timed out.');
}

module.exports = { submitDownload, getDownloadStatus, waitForDownload };
