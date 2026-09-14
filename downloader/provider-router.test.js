const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyPlatform,
  extractUrl,
  buildPlan,
} = require('./provider-router');
const {
  isAllowedMediaUrl,
  normalizeSnapchatResponse,
  mediaTypeFromSnapchatType,
} = require('./snapchat-provider');
const {
  isAllowedInstagramMediaUrl,
  normalizeInstagramResponse,
  normalizeDownloadType,
} = require('./instagram-provider');

test('classifies supported platforms', () => {
  assert.equal(classifyPlatform('https://www.youtube.com/watch?v=abc'), 'youtube');
  assert.equal(classifyPlatform('https://youtu.be/abc'), 'youtube');
  assert.equal(classifyPlatform('https://www.tiktok.com/@user/video/1'), 'tiktok');
  assert.equal(classifyPlatform('https://www.instagram.com/reel/1/'), 'instagram');
  assert.equal(classifyPlatform('https://www.facebook.com/watch/?v=1'), 'facebook');
  assert.equal(classifyPlatform('https://x.com/user/status/1'), 'x');
  assert.equal(classifyPlatform('https://www.threads.net/@user/post/1'), 'threads');
  assert.equal(classifyPlatform('https://www.reddit.com/r/test/comments/abc/'), 'reddit');
  assert.equal(classifyPlatform('https://www.snapchat.com/add/ansh_trio'), 'snapchat');
});

test('does not misclassify lookalike domains', () => {
  assert.equal(classifyPlatform('https://notyoutube.com/watch?v=abc'), 'generic');
  assert.equal(classifyPlatform('https://evil-tiktok.com/video/1'), 'generic');
  assert.equal(classifyPlatform('https://not-snapchat.com/add/user'), 'generic');
});

test('extracts the first HTTP(S) URL from command arguments', () => {
  assert.equal(
    extractUrl(['--no-playlist', '-o', '/tmp/output', 'https://example.com/video']),
    'https://example.com/video'
  );
  assert.equal(extractUrl(['--no-playlist']), null);
});

test('builds explicit operation plans', () => {
  assert.deepEqual(buildPlan({ url: 'https://www.youtube.com/watch?v=abc', operation: 'download' }), {
    platform: 'youtube',
    operation: 'download',
    primary: 'yt-dlp',
    fallbacks: ['you-get'],
  });

  assert.deepEqual(buildPlan({ url: 'https://www.youtube.com/watch?v=abc', operation: 'metadata' }), {
    platform: 'youtube',
    operation: 'metadata',
    primary: 'yt-dlp',
    fallbacks: [],
  });
});

test('normalizes the supplied Snapchat response shape', () => {
  const normalized = normalizeSnapchatResponse({
    status: 'success',
    counts: { highlights: 2, spotlight: 3, stories: 0, total: 5 },
    profile: {
      username: 'ansh_trio',
      displayName: 'Example User',
      bio: '',
      subscribers: '0',
      avatar: 'https://cf-st.sc-cdn.net/aps/avatar',
    },
    media: [
      {
        source: 'spotlight',
        thumb: 'https://bolt-gcdn.sc-cdn.net/bk/thumb.256',
        timestamp: 1787154865,
        type: 1,
        url: 'https://bolt-gcdn.sc-cdn.net/bk/video.27',
      },
      {
        source: 'highlight',
        thumb: 'https://cf-st.sc-cdn.net/d/image.410',
        timestamp: 1786018918,
        type: 0,
        url: 'https://cf-st.sc-cdn.net/d/image.400',
      },
      {
        source: 'spotlight',
        url: 'https://example.com/not-snapchat-media',
      },
    ],
  });

  assert.equal(normalized.status, 'success');
  assert.equal(normalized.profile.username, 'ansh_trio');
  assert.equal(normalized.profile.subscribers, 0);
  assert.equal(normalized.counts.total, 2);
  assert.equal(normalized.media[0].source, 'spotlight');
  assert.equal(normalized.media[0].url.includes('bolt-gcdn.sc-cdn.net'), true);
  assert.equal(normalized.media[1].thumbnail.includes('cf-st.sc-cdn.net'), true);
});

test('rejects non-Snapchat media hosts', () => {
  assert.equal(isAllowedMediaUrl('https://example.com/file.mp4'), false);
  assert.equal(isAllowedMediaUrl('javascript:alert(1)'), false);
  assert.equal(isAllowedMediaUrl('https://bolt-gcdn.sc-cdn.net/file.mp4'), true);
});

test('maps Snapchat sample media types without trusting unknown values', () => {
  assert.equal(mediaTypeFromSnapchatType(1), 'video');
  assert.equal(mediaTypeFromSnapchatType(0), 'image');
  assert.equal(mediaTypeFromSnapchatType(99), 'media');
});

test('normalizes the supplied Instagram response shape', () => {
  const normalized = normalizeInstagramResponse({
    success: true,
    platform: 'instagram',
    thumbnail: 'https://www.instagram.com/p/example/media/?size=l',
    title: 'Example post',
    downloads: [
      {
        type: 'image',
        url: 'https://cdninstagram.com/media/photo.jpg',
      },
      {
        type: 'video',
        quality: 'original',
        url: 'https://scontent.cdninstagram.com/media/video.mp4',
      },
      {
        type: 'video',
        url: 'https://evil.example.com/video.mp4',
      },
    ],
  });

  assert.equal(normalized.success, true);
  assert.equal(normalized.platform, 'instagram');
  assert.equal(normalized.title, 'Example post');
  assert.equal(normalized.count, 2);
  assert.equal(normalized.downloads[0].type, 'image');
  assert.equal(normalized.downloads[0].filename, 'photo.jpg');
  assert.equal(normalized.downloads[1].quality, 'original');
});

test('Instagram URL validation is HTTPS and host based', () => {
  assert.equal(isAllowedInstagramMediaUrl('https://cdninstagram.com/media/file.mp4'), true);
  assert.equal(isAllowedInstagramMediaUrl('https://www.instagram.com/p/abc/'), true);
  assert.equal(isAllowedInstagramMediaUrl('https://example.com/file.mp4'), false);
  assert.equal(isAllowedInstagramMediaUrl('javascript:alert(1)'), false);
  assert.equal(
    isAllowedInstagramMediaUrl('https://media.example.net/file.mp4', ['media.example.net']),
    true
  );
});

test('normalizes Instagram media types conservatively', () => {
  assert.equal(normalizeDownloadType('image'), 'image');
  assert.equal(normalizeDownloadType('photo'), 'image');
  assert.equal(normalizeDownloadType('video'), 'video');
  assert.equal(normalizeDownloadType('reel'), 'video');
  assert.equal(normalizeDownloadType('audio'), 'audio');
  assert.equal(normalizeDownloadType('something-new'), 'media');
});
