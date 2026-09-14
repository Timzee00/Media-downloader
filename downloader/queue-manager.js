'use strict';

class JobQueue {
  constructor({ concurrency = 2, maxPending = 50, onEvent = () => {} } = {}) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new TypeError('concurrency must be a positive integer');
    if (!Number.isInteger(maxPending) || maxPending < 0) throw new TypeError('maxPending must be a non-negative integer');
    this.concurrency = concurrency;
    this.maxPending = maxPending;
    this.onEvent = typeof onEvent === 'function' ? onEvent : () => {};
    this.running = 0;
    this.pending = [];
    this.sequence = 0;
  }

  get size() { return this.pending.length; }
  get active() { return this.running; }
  get availableSlots() { return Math.max(0, this.concurrency - this.running); }

  add(task, meta = {}) {
    if (typeof task !== 'function') return Promise.reject(new TypeError('Queue task must be a function'));
    if (this.pending.length >= this.maxPending) {
      const error = new Error('Download queue is full. Please try again shortly.');
      error.code = 'QUEUE_FULL';
      return Promise.reject(error);
    }

    const id = `${Date.now().toString(36)}-${(++this.sequence).toString(36)}`;
    return new Promise((resolve, reject) => {
      this.pending.push({ id, task, meta, resolve, reject, enqueuedAt: Date.now() });
      this.onEvent('queued', { id, pending: this.pending.length, running: this.running, ...meta });
      this.#drain();
    });
  }

  snapshot() {
    return {
      concurrency: this.concurrency,
      running: this.running,
      pending: this.pending.length,
      availableSlots: this.availableSlots,
      accepting: this.pending.length < this.maxPending,
    };
  }

  async #drain() {
    while (this.running < this.concurrency && this.pending.length) {
      const item = this.pending.shift();
      this.running += 1;
      this.onEvent('started', {
        id: item.id,
        waitMs: Date.now() - item.enqueuedAt,
        pending: this.pending.length,
        running: this.running,
        ...item.meta,
      });

      Promise.resolve()
        .then(() => item.task())
        .then(result => {
          item.result = result;
          item.succeeded = true;
        })
        .catch(error => {
          item.error = error;
          item.succeeded = false;
        })
        .finally(() => {
          this.running -= 1;
          if (item.succeeded) {
            this.onEvent('succeeded', { id: item.id, pending: this.pending.length, running: this.running, ...item.meta });
            item.resolve(item.result);
          } else {
            this.onEvent('failed', {
              id: item.id,
              pending: this.pending.length,
              running: this.running,
              error: String(item.error?.message || item.error),
              ...item.meta,
            });
            item.reject(item.error);
          }
          this.#drain();
        });
    }
  }
}

module.exports = { JobQueue };
