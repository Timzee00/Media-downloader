const test = require('node:test');
const assert = require('node:assert/strict');
const { buildEndpoint, extractDownloadUrl, extractMetadata } = require('./curiousapi');

test('builds the CuriousAPI endpoint with an encoded source URL', () => {
  const source = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&x=1';
  assert.equal(
    buildEndpoint(source),
    'https://curiousapis.name.ng/aio_downloader/download/aio?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ%26x%3D1'
  );
});

test('extracts nested media URL and metadata from provider payloads', () => {
  const data = {
    result: {
      url: 'https://cdn.example.com/file.mp4',
      title: 'Example video',
      thumbnailUrl: 'https://cdn.example.com/thumb.jpg',
      duration: 42,
      author: 'Example creator',
      platform: 'youtube'
    }
  };

  assert.equal(extractDownloadUrl(data), 'https://cdn.example.com/file.mp4');
  assert.deepEqual(extractMetadata(data), {
    title: 'Example video',
    thumbnail: 'https://cdn.example.com/thumb.jpg',
    duration: 42,
    uploader: 'Example creator',
    extractor: 'youtube'
  });
});
