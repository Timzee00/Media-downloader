'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  videoFormatFor,
  selectCompletedOutput,
  cleanupJobFiles,
  normalizeDownloadError,
} = require('./download-utils');

test('video format preferences favor mp4 video and m4a audio with safe fallbacks', () => {
  assert.match(videoFormatFor('best'), /bv\*\[ext=mp4\]\+ba\[ext=m4a\]/);
  assert.match(videoFormatFor('1080p'), /height<=1080/);
  assert.match(videoFormatFor('invalid'), /bv\*\+ba\/b$/);
});

test('selectCompletedOutput ignores partial files and chooses a completed media file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-downloader-'));
  const id = 'job-123';
  fs.writeFileSync(path.join(dir, `${id}.part`), 'partial');
  fs.writeFileSync(path.join(dir, `${id}.mp4`), 'video');
  fs.writeFileSync(path.join(dir, `${id}.ytdl`), 'temp');
  try {
    const result = selectCompletedOutput(dir, id, 'video');
    assert.equal(result.name, `${id}.mp4`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanupJobFiles removes only files belonging to the job', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-downloader-'));
  const id = 'job-456';
  fs.writeFileSync(path.join(dir, `${id}.part`), 'partial');
  fs.writeFileSync(path.join(dir, `${id}.mp4`), 'video');
  fs.writeFileSync(path.join(dir, 'other-job.mp4'), 'keep');
  try {
    assert.equal(cleanupJobFiles(dir, id), 2);
    assert.equal(fs.existsSync(path.join(dir, `${id}.mp4`)), false);
    assert.equal(fs.existsSync(path.join(dir, 'other-job.mp4')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizes common provider failures into user-facing messages', () => {
  assert.match(normalizeDownloadError(new Error('ERROR: Unsupported URL')), /not supported/i);
  assert.match(normalizeDownloadError(new Error('HTTP Error 403: Forbidden')), /rejected/i);
  assert.match(normalizeDownloadError(new Error('Requested format is not available')), /quality/i);
});
