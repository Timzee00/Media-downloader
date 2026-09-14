'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JobQueue } = require('./queue-manager');

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

test('runs no more than the configured concurrency', async () => {
  const queue = new JobQueue({ concurrency: 2 });
  let running = 0;
  let peak = 0;

  const jobs = Array.from({ length: 6 }, (_, index) => queue.add(async () => {
    running += 1;
    peak = Math.max(peak, running);
    await sleep(15);
    running -= 1;
    return index;
  }));

  const results = await Promise.all(jobs);
  assert.equal(peak, 2);
  assert.deepEqual(results, [0, 1, 2, 3, 4, 5]);
  assert.equal(queue.active, 0);
  assert.equal(queue.size, 0);
});

test('propagates task failures without stopping later jobs', async () => {
  const queue = new JobQueue({ concurrency: 1 });
  const first = queue.add(async () => { throw new Error('boom'); });
  const second = queue.add(async () => 'ok');

  await assert.rejects(first, /boom/);
  assert.equal(await second, 'ok');
});

test('rejects new work when the pending queue is full', async () => {
  const queue = new JobQueue({ concurrency: 1, maxPending: 1 });
  const blocker = queue.add(async () => sleep(20));
  const queued = queue.add(async () => 'queued');
  await assert.rejects(queue.add(async () => 'overflow'), error => error.code === 'QUEUE_FULL');
  await blocker;
  assert.equal(await queued, 'queued');
});
