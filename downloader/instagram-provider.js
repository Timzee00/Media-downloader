const { URL } = require('url');

/**
 * Instagram provider helpers.
 *
 * This module normalizes an Instagram provider response into the downloader's
 * internal media shape. It does not call or depend on a third-party broker.
 */

const INSTAGRAM_MEDIA_HOST_SUFFIXES = [
  'instagram.com',
  'cdninstagram.com',
  'fbcdn.net',
  'fbsbx.com',
];

function isAllowedInstagramMediaUrl(value, extraHosts = []) {
  try {
    const parsed = new URL(String(value));
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;

    const host = parsed.hostname.toLowerCase();
    const allowedSuffixes = [
      ...INSTAGRAM_MEDIA_HOST_SUFFIXES,
      ...extraHosts.map(item => String(item).toLowerCase().trim()).filter(Boolean),
    ];

    return allowedSuffixes.some(
      suffix => host === suffix || host.endsWith(`.${suffix}`)
    );
  } catch {
    return false;
  }
}

function normalizeDownloadType(value) {
  const type = String(value || '').toLowerCase();
  if (type === 'image' || type === 'photo') return 'image';
  if (type === 'video' || type === 'reel') return 'video';
  if (type === 'audio') return 'audio';
  return 'media';
}

function filenameFromUrl(value) {
  try {
    const parsed = new URL(String(value));
    const name = decodeURIComponent(parsed.pathname.split('/').pop() || '');
    return name && name.length <= 240 ? name : null;
  } catch {
    return null;
  }
}

function normalizeInstagramResponse(payload, options = {}) {
  if (!payload || typeof payload !== 'object') {
    throw new TypeError('Invalid Instagram provider response.');
  }

  const extraHosts = Array.isArray(options.extraMediaHosts)
    ? options.extraMediaHosts
    : [];

  const downloads = Array.isArray(payload.downloads)
    ? payload.downloads
        .map((item, index) => {
          if (!item || typeof item !== 'object') return null;
          if (!isAllowedInstagramMediaUrl(item.url, extraHosts)) return null;

          const type = normalizeDownloadType(item.type);
          return {
            id: `${type}-${index + 1}`,
            type,
            quality: item.quality ? String(item.quality) : 'original',
            url: String(item.url),
            filename: item.filename
              ? String(item.filename)
              : filenameFromUrl(item.url),
          };
        })
        .filter(Boolean)
    : [];

  return {
    success: payload.success === true,
    platform: 'instagram',
    thumbnail: isAllowedInstagramMediaUrl(payload.thumbnail, extraHosts)
      ? String(payload.thumbnail)
      : null,
    title: payload.title ? String(payload.title) : null,
    downloads,
    count: downloads.length,
  };
}

module.exports = {
  INSTAGRAM_MEDIA_HOST_SUFFIXES,
  isAllowedInstagramMediaUrl,
  normalizeDownloadType,
  filenameFromUrl,
  normalizeInstagramResponse,
};
