import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DownloadPool } from '../scripts/pool.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'financial-pool-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'worker.mjs');
  await writeFile(path, `
    import { parentPort } from 'node:worker_threads';
    parentPort.on('message', ({ id, task }) => {
      if (task.kind === 'done') parentPort.postMessage({ id, bars: task.bars });
      else if (task.kind === 'error') parentPort.postMessage({ id, error: { message: 'provider unavailable' } });
      else if (task.kind === 'crash') throw new Error('worker crashed');
      // A hang deliberately leaves the request pending until the worker is terminated.
    });
  `);
  return pathToFileURL(path);
}

test('deadline terminates hanging downloads while preserving already completed results', async t => {
  const workerUrl = await fixture(t);
  const started = Date.now();
  const pool = new DownloadPool({ workerUrl, deadline: started + 500, taskTimeoutMs: 10_000 });
  t.after(() => pool.stop());
  const bars = [{ timestamp: 123, close: 4 }];
  const completed = await pool.download({ kind: 'done', bars });
  assert.deepEqual(completed, { bars });
  const hung = await pool.download({ kind: 'hang' });
  assert.deepEqual(hung, { cancelled: true });
  assert.equal(pool.stopped, true);
  assert.equal(pool.pending.size, 0);
  assert.ok(Date.now() - started < 2_000, 'deadline cancellation should not wait for the provider timeout');
  assert.deepEqual(await pool.download({ kind: 'done', bars: [] }), { cancelled: true });
  assert.deepEqual(completed, { bars }, 'cancellation must not overwrite successfully returned work');
});

test('task timeout stops the worker and settles every outstanding request', async t => {
  const workerUrl = await fixture(t);
  const pool = new DownloadPool({ workerUrl, deadline: Date.now() + 10_000, taskTimeoutMs: 100 });
  t.after(() => pool.stop());
  const results = await Promise.all([pool.download({ kind: 'hang' }), pool.download({ kind: 'hang' })]);
  assert.equal(results.length, 2);
  for (const result of results) assert.match(result.error.message, /timed out/);
  assert.equal(pool.pending.size, 0);
  assert.equal(pool.stopped, true);
});

test('provider errors settle their own request and successful requests can continue', async t => {
  const workerUrl = await fixture(t);
  const pool = new DownloadPool({ workerUrl, deadline: Date.now() + 10_000 });
  t.after(() => pool.stop());
  const result = await pool.download({ kind: 'error' });
  assert.match(result.error.message, /provider unavailable/);
  assert.equal(pool.stopped, false);
  assert.deepEqual(await pool.download({ kind: 'done', bars: [] }), { bars: [] });
});

test('worker crashes settle pending requests instead of losing them', async t => {
  const workerUrl = await fixture(t);
  const pool = new DownloadPool({ workerUrl, deadline: Date.now() + 10_000 });
  t.after(() => pool.stop());
  const [crashed, pending] = await Promise.all([
    pool.download({ kind: 'crash' }), pool.download({ kind: 'hang' }),
  ]);
  assert.match(crashed.error.message, /worker crashed/);
  assert.match(pending.error.message, /worker crashed/);
  assert.equal(pool.stopped, true);
});
