'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getProvider, supports, providerSummary } = require('./platform-providers');

test('returns the correct provider capabilities', () => {
  assert.equal(getProvider('tiktok').engine, 'yt-dlp');
  assert.equal(getProvider('tiktok').specialHandler, 'tiktok-photo');
  assert.equal(supports('instagram', 'photo'), true);
  assert.equal(supports('youtube', 'photo'), false);
});

test('unknown platforms use the generic provider', () => {
  assert.equal(getProvider('unknown').id, 'generic');
  assert.equal(supports('unknown', 'video'), true);
});

test('provider summary contains the supported platforms', () => {
  const ids = providerSummary().map(item => item.id);
  for (const id of ['youtube', 'tiktok', 'instagram', 'facebook', 'x', 'threads', 'reddit', 'generic']) {
    assert.ok(ids.includes(id));
  }
});
