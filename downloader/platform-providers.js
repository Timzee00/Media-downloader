'use strict';

const PROVIDERS = {
  youtube: {
    id: 'youtube',
    engine: 'yt-dlp',
    media: ['video', 'audio'],
    notes: 'Use the standard public extractor path; platform-side access restrictions are surfaced as upstream errors.',
  },
  tiktok: {
    id: 'tiktok',
    engine: 'yt-dlp',
    media: ['video', 'audio', 'photo'],
    specialHandler: 'tiktok-photo',
  },
  instagram: {
    id: 'instagram',
    engine: 'yt-dlp',
    media: ['video', 'audio', 'photo'],
  },
  facebook: {
    id: 'facebook',
    engine: 'yt-dlp',
    media: ['video', 'audio'],
  },
  x: {
    id: 'x',
    engine: 'yt-dlp',
    media: ['video', 'audio'],
  },
  threads: {
    id: 'threads',
    engine: 'yt-dlp',
    media: ['video', 'audio', 'photo'],
  },
  reddit: {
    id: 'reddit',
    engine: 'yt-dlp',
    media: ['video', 'audio', 'photo'],
  },
  generic: {
    id: 'generic',
    engine: 'yt-dlp',
    media: ['video', 'audio'],
  },
};

function getProvider(platform) {
  return PROVIDERS[platform] || PROVIDERS.generic;
}

function supports(platform, mediaType) {
  return getProvider(platform).media.includes(mediaType);
}

function providerSummary() {
  return Object.values(PROVIDERS).map(({ id, engine, media, specialHandler }) => ({
    id,
    engine,
    media,
    ...(specialHandler ? { specialHandler } : {}),
  }));
}

module.exports = { PROVIDERS, getProvider, supports, providerSummary };
