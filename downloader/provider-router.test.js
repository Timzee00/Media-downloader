const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyPlatform,
  extractUrl,
  buildPlan,
} = require('./provider-router');

test('classifies supported platforms', () => {
  assert.equal(classifyPlatform('https://www.youtube.com/watch?v=abc'), 'youtube');
  assert.equal(classifyPlatform('https://youtu.be/abc'), 'youtube');
  assert.equal(classifyPlatform('https://www.tiktok.com/@user/video/1'), 'tiktok');
  assert.equal(classifyPlatform('https://www.instagram.com/reel/1/'), 'instagram');
  assert.equal(classifyPlatform('https://www.facebook.com/watch/?v=1'), 'facebook');
  assert.equal(classifyPlatform('https://x.com/user/status/1'), 'x');
  assert.equal(classifyPlatform('https://www.threads.net/@user/post/1'), 'threads');
  assert.equal(classifyPlatform('https://www.reddit.com/r/test/comments/abc/'), 'reddit');
});

test('does not misclassify lookalike domains', () => {
  assert.equal(classifyPlatform('https://notyoutube.com/watch?v=abc'), 'generic');
  assert.equal(classifyPlatform('https://evil-tiktok.com/video/1'), 'generic');
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
