const { URL } = require('url');

/**
 * Snapchat provider helpers.
 *
 * This module intentionally does not depend on a private/undocumented Snapchat
 * backend. It normalizes a response shaped like the public API example the
 * project is targeting and provides safe URL/media classification helpers.
 */

const ALLOWED_MEDIA_HOST_SUFFIXES = [
  'sc-cdn.net',
  'snapchat.com',
  'snap.com',
];

function isAllowedMediaUrl(value) {
  try {
    const parsed = new URL(String(value));
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const host = parsed.hostname.toLowerCase();
    return ALLOWED_MEDIA_HOST_SUFFIXES.some(
      suffix => host === suffix || host.endsWith(`.${suffix}`)
    );
  } catch {
    return false;
  }
}

function normalizeTimestamp(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

function normalizeMediaItem(item, index = 0) {
  if (!item || typeof item !== 'object') return null;
  const url = isAllowedMediaUrl(item.url) ? item.url : null;
  const thumb = isAllowedMediaUrl(item.thumb) ? item.thumb : null;
  if (!url) return null;

  return {
    id: `${item.source || 'media'}-${index + 1}`,
    source: String(item.source || 'snapchat').toLowerCase(),
    url,
    thumbnail: thumb,
    timestamp: normalizeTimestamp(item.timestamp),
    type: Number.isFinite(Number(item.type)) ? Number(item.type) : null,
  };
}

function normalizeSnapchatResponse(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new TypeError('Invalid Snapchat provider response.');
  }

  const profile = payload.profile && typeof payload.profile === 'object'
    ? payload.profile
    : {};

  const media = Array.isArray(payload.media)
    ? payload.media.map(normalizeMediaItem).filter(Boolean)
    : [];

  return {
    status: payload.status === 'success' ? 'success' : 'partial',
    profile: {
      username: profile.username ? String(profile.username) : null,
      displayName: profile.displayName ? String(profile.displayName) : null,
      bio: profile.bio ? String(profile.bio) : '',
      avatar: isAllowedMediaUrl(profile.avatar) ? profile.avatar : null,
      subscribers: Number.isFinite(Number(profile.subscribers))
        ? Number(profile.subscribers)
        : null,
    },
    counts: {
      highlights: Number(payload.counts?.highlights || 0),
      spotlight: Number(payload.counts?.spotlight || 0),
      stories: Number(payload.counts?.stories || 0),
      total: media.length,
    },
    media,
  };
}

function mediaTypeFromSnapchatType(type) {
  // The sample response uses 0/1. Treat 1 as video and 0 as image, while
  // keeping unknown values generic rather than making unsafe assumptions.
  if (Number(type) === 1) return 'video';
  if (Number(type) === 0) return 'image';
  return 'media';
}

module.exports = {
  isAllowedMediaUrl,
  normalizeMediaItem,
  normalizeSnapchatResponse,
  mediaTypeFromSnapchatType,
};
