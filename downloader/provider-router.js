const { URL } = require('url');

/**
 * Small, dependency-free provider routing layer.
 *
 * It does not attempt to bypass platform protections. It only decides which
 * already-installed downloader engine should handle a public URL and provides
 * a consistent fallback order for the API layer.
 */

const PLATFORM_RULES = [
  { id: 'youtube', hosts: ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be'] },
  { id: 'tiktok', hosts: ['tiktok.com', 'www.tiktok.com', 'm.tiktok.com'] },
  { id: 'instagram', hosts: ['instagram.com', 'www.instagram.com'] },
  { id: 'facebook', hosts: ['facebook.com', 'www.facebook.com', 'm.facebook.com', 'fb.watch'] },
  { id: 'x', hosts: ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'] },
  { id: 'threads', hosts: ['threads.net', 'www.threads.net'] },
  { id: 'reddit', hosts: ['reddit.com', 'www.reddit.com', 'old.reddit.com', 'redd.it'] },
  { id: 'snapchat', hosts: ['snapchat.com', 'www.snapchat.com'] },
];

function normalizeHost(hostname) {
  return String(hostname || '').toLowerCase().replace(/^www\./, '');
}

function extractUrl(args) {
  return (Array.isArray(args) ? args : []).find(arg => /^https?:\/\//i.test(String(arg))) || null;
}

function classifyPlatform(rawUrl) {
  if (!rawUrl) return 'unknown';
  try {
    const host = normalizeHost(new URL(rawUrl).hostname);
    for (const rule of PLATFORM_RULES) {
      if (rule.hosts.some(candidate => normalizeHost(candidate) === host)) return rule.id;
      if (host.endsWith(`.${normalizeHost(rule.hosts[0])}`)) return rule.id;
    }
    return 'generic';
  } catch {
    return 'unknown';
  }
}

function buildPlan({ url, operation = 'download' } = {}) {
  const platform = classifyPlatform(url);

  // Keep the plan explicit so future platform-specific providers can be added
  // without changing the HTTP API or job model.
  const primary = 'yt-dlp';
  const fallbacks = operation === 'download' ? ['you-get'] : [];

  return {
    platform,
    operation,
    primary,
    fallbacks,
  };
}

async function runProviderPlan({
  url,
  args,
  operation = 'download',
  runEngine,
  runYouGet,
  destinationPrefix,
  meta = {},
} = {}) {
  if (typeof runEngine !== 'function') {
    throw new TypeError('runProviderPlan requires runEngine(command, args, meta)');
  }

  const plan = buildPlan({ url, operation });
  const commonMeta = { providerPlatform: plan.platform, providerPlan: plan, ...meta };

  try {
    return await runEngine('yt-dlp', args, commonMeta);
  } catch (primaryError) {
    if (operation !== 'download' || typeof runYouGet !== 'function') throw primaryError;

    try {
      return await runYouGet(url, destinationPrefix, {
        providerPlatform: plan.platform,
        providerPlan: plan,
        primaryError: primaryError.message,
      });
    } catch (fallbackError) {
      const combined = new Error(
        `All configured providers failed. ${plan.primary}: ${primaryError.message || 'failed'}. ` +
        `Fallback you-get: ${fallbackError.message || 'failed'}.`
      );
      combined.code = 'ALL_PROVIDERS_FAILED';
      combined.providerPlan = plan;
      combined.primaryError = primaryError.message || String(primaryError);
      combined.fallbackError = fallbackError.message || String(fallbackError);
      throw combined;
    }
  }
}

module.exports = {
  PLATFORM_RULES,
  extractUrl,
  classifyPlatform,
  buildPlan,
  runProviderPlan,
};
