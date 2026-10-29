import { Worker } from 'node:worker_threads';

/** Isolate provider sockets/browser recovery so deadline cancellation really stops downloads. */
export class DownloadPool {
  constructor({ deadline, workerUrl = new URL('./download-worker.mjs', import.meta.url), taskTimeoutMs = 180_000 }) {
    this.pending = new Map();
    this.counter = 0;
    this.stopped = false;
    this.worker = new Worker(workerUrl, {
      // CLI/test-runner flags (notably --input-type) are not valid for a file worker.
      execArgv: [],
    });
    this.worker.on('message', result => {
      const pending = this.pending.get(result.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(result.id);
      pending.resolve(result.error ? { error: new Error(result.error.message) } : { bars: result.bars });
    });
    this.worker.on('error', error => this.stop(error));
    this.worker.on('exit', code => {
      if (!this.stopped) this.stop(new Error(`Download worker exited (${code})`));
    });
    this.deadlineTimer = setTimeout(() => this.stop(), Math.max(0, deadline - Date.now()));
    this.taskTimeoutMs = taskTimeoutMs;
  }

  download(task) {
    if (this.stopped) return Promise.resolve({ cancelled: true });
    const id = ++this.counter;
    return new Promise(resolve => {
      const timer = setTimeout(() => this.stop(new Error('Provider request timed out; checkpointing completed work')), this.taskTimeoutMs);
      this.pending.set(id, { resolve, timer });
      this.worker.postMessage({ id, task });
    });
  }

  async stop(error = null) {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.deadlineTimer);
    for (const { resolve, timer } of this.pending.values()) {
      clearTimeout(timer);
      resolve(error ? { error } : { cancelled: true });
    }
    this.pending.clear();
    await this.worker.terminate();
  }
}
