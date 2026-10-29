import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { GitHubReleases } from '../scripts/github.mjs';

const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers });
const client = (fetchImpl, options = {}) => new GitHubReleases({
  repository: 'owner/repo', token: 'secret-token', minWriteIntervalMs: 0,
  fetchImpl, ...options,
});

test('release listing follows every full page rather than the embedded asset subset', async () => {
  const seen = [];
  const github = client(async (url) => {
    seen.push(String(url));
    return json(url.searchParams.get('page') === '1' ? Array.from({ length: 100 }, (_, id) => ({ id })) : [{ id: 101 }]);
  });
  assert.equal((await github.listAssets(23)).length, 101);
  assert.match(seen[1], /page=2$/);
});

test('draft creation and latest publication use the safe order and explicit latest flag', async () => {
  const bodies = [];
  const github = client(async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return json({ id: 10 });
  });
  await github.createDraft({ tag: 'data-1', body: 'snapshot', target: 'abc123' });
  await github.publish(10);
  assert.equal(bodies[0].draft, true);
  assert.equal(bodies[0].target_commitish, 'abc123');
  assert.deepEqual(bodies[1], { draft: false, make_latest: 'true' });
});

test('final archive renaming patches metadata by asset ID instead of replacing bytes', async () => {
  const github = client(async (url, options) => {
    assert.equal(url.pathname, '/repos/owner/repo/releases/assets/35');
    assert.equal(options.method, 'PATCH');
    assert.deepEqual(JSON.parse(options.body), { name: 'bonds-h1-part001.tar' });
    return json({ id: 35, name: 'bonds-h1-part001.tar' });
  });
  assert.deepEqual(await github.renameAsset(35, 'bonds-h1-part001.tar'), { id: 35, name: 'bonds-h1-part001.tar' });
});

test('handoff polling reads only scheduled runs of the requested workflow without canceling jobs', async () => {
  const runs = [{ id: 42, run_number: 5, event: 'schedule', status: 'pending' }];
  const github = client(async (url, options) => {
    assert.equal(url.pathname, '/repos/owner/repo/actions/workflows/historical-data.yml/runs');
    assert.equal(url.searchParams.get('event'), 'schedule');
    assert.equal(url.searchParams.get('per_page'), '100');
    assert.equal(options.method, undefined);
    assert.equal(options.headers.Authorization, 'Bearer secret-token');
    return json({ workflow_runs: runs });
  });
  assert.deepEqual(await github.listScheduledRuns('historical-data.yml'), runs);
  await assert.rejects(github.listScheduledRuns('../another-workflow.yml'), /workflow YAML/);
});

test('handoff reads can be aborted promptly and expose rate-limit delays without blocking retries', async () => {
  const controller = new AbortController();
  const stalled = client(async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    controller.abort();
  }));
  await assert.rejects(stalled.listScheduledRuns('historical-data.yml', { signal: controller.signal }), { name: 'AbortError' });

  let requests = 0;
  const limited = client(async () => {
    requests += 1;
    return json({ message: 'rate limited' }, 429, { 'retry-after': '60' });
  });
  await assert.rejects(limited.listScheduledRuns('historical-data.yml'), error => error.retryAfterMs === 60_000);
  assert.equal(requests, 1);
});

test('ordinary permission errors fail immediately; primary and secondary limits are retried', async () => {
  let calls = 0;
  const denied = client(async () => { calls += 1; return json({ message: 'Resource not accessible' }, 403); });
  await assert.rejects(denied.listReleases(), /HTTP 403/);
  assert.equal(calls, 1);

  const waits = [];
  const responses = [
    json({ message: 'rate limited' }, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '105' }),
    json({ message: 'secondary rate limit' }, 403),
    json([]),
  ];
  const limited = client(async () => responses.shift(), { now: () => 100_000, sleep: async (ms) => waits.push(ms) });
  assert.deepEqual(await limited.listReleases(), []);
  assert.deepEqual(waits, [6_000, 60_000]);
});

test('Retry-After is honored and retries are bounded', async () => {
  const waits = [];
  let attempts = 0;
  const github = client(async () => {
    attempts += 1;
    return json({ message: 'limited' }, 429, { 'retry-after': '9' });
  }, { retries: 2, sleep: async (ms) => waits.push(ms) });
  await assert.rejects(github.listReleases(), /HTTP 429/);
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [9_000, 9_000]);
});

test('mutations share the write pacing queue', async () => {
  let now = 0;
  const starts = [];
  const github = client(async () => { starts.push(now); return new Response(null, { status: 204 }); }, {
    minWriteIntervalMs: 8_000,
    now: () => now,
    sleep: async (ms) => { now += ms; },
  });
  await Promise.all([github.deleteRelease(1), github.deleteRelease(2), github.deleteRelease(3)]);
  assert.deepEqual(starts, [0, 8_000, 16_000]);
});

test('asset redirect never forwards credentials to object storage and downloads atomically', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'financial-github-'));
  try {
    const calls = [];
    const github = client(async (url, options) => {
      calls.push({ url: String(url), options });
      return calls.length === 1
        ? new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/file?signature=secret' } })
        : new Response('bars');
    });
    const destination = join(directory, 'asset.tar');
    const result = await github.downloadAsset({ id: 5, name: 'asset.tar', size: 4 }, destination);
    assert.equal(await readFile(destination, 'utf8'), 'bars');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer secret-token');
    assert.equal(calls[1].options.headers.Authorization, undefined);
    assert.equal(result.sha256, createHash('sha256').update('bars').digest('hex'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a corrupt download leaves an existing checkpoint untouched', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'financial-github-'));
  try {
    const destination = join(directory, 'asset.tar');
    await writeFile(destination, 'previous');
    const github = client(async () => new Response('bad'));
    await assert.rejects(github.downloadAsset({ id: 5, name: 'asset.tar', size: 10 }, destination), /size mismatch/);
    assert.equal(await readFile(destination, 'utf8'), 'previous');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('uploads stream files and recover an already completed upload after an ambiguous response', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'financial-github-'));
  try {
    const file = join(directory, 'group.tar');
    await writeFile(file, 'data');
    const digest = `sha256:${createHash('sha256').update('data').digest('hex')}`;
    const asset = { id: 1, name: 'group.tar', state: 'uploaded', size: 4, digest };
    let uploads = 0;
    const github = client(async (url, options) => {
      if (url.hostname === 'uploads.github.com') {
        uploads += 1;
        assert.equal(options.headers['Content-Length'], '4');
        assert.equal(options.duplex, 'half');
        throw new TypeError('fetch failed after the server accepted the upload');
      }
      return json([asset]);
    }, { sleep: async () => {} });
    assert.deepEqual(await github.uploadAsset({ id: 4, upload_url: 'https://uploads.github.com/repos/owner/repo/releases/4/assets{?name,label}' }, file), asset);
    assert.equal(uploads, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an incomplete starter asset is removed before retrying an upload', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'financial-github-'));
  try {
    const file = join(directory, 'group.tar');
    await writeFile(file, 'data');
    const calls = [];
    const github = client(async (url, options) => {
      calls.push({ url: String(url), method: options.method || 'GET' });
      if (url.hostname === 'uploads.github.com') {
        return calls.length === 1 ? json({ message: 'already_exists' }, 422) :
          json({ id: 2, name: 'group.tar', state: 'uploaded', size: 4 });
      }
      if (options.method === 'DELETE') return new Response(null, { status: 204 });
      return json(calls.some((call) => call.method === 'DELETE') ? [] :
        [{ id: 1, name: 'group.tar', state: 'starter', size: 0 }]);
    }, { sleep: async () => {} });
    const asset = await github.uploadAsset({ id: 4, upload_url: 'https://uploads.github.com/repos/owner/repo/releases/4/assets{?name,label}' }, file);
    assert.equal(asset.id, 2);
    assert.equal(calls.filter((call) => call.method === 'DELETE').length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an expired finalization deadline refuses requests, including a deadline assigned after construction', async () => {
  let calls = 0;
  const github = client(async () => { calls += 1; return json([]); }, { now: () => 100_000 });
  github.deadline = 100_000;
  await assert.rejects(github.listReleases(), /finalization deadline/);
  assert.equal(calls, 0);
});

test('rate-limit backoff cannot sleep past the finalization deadline', async () => {
  const waits = [];
  let calls = 0;
  const github = client(async () => {
    calls += 1;
    return json({ message: 'rate limited' }, 429, { 'retry-after': '9' });
  }, { now: () => 100_000, deadline: 105_000, sleep: async ms => waits.push(ms) });
  await assert.rejects(github.listReleases(), /finalization deadline/);
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
});

test('write pacing refuses a queued mutation when its wait would exceed the deadline', async () => {
  const waits = [];
  let calls = 0;
  const github = client(async () => {
    calls += 1;
    return new Response(null, { status: 204 });
  }, { now: () => 0, deadline: 5_000, minWriteIntervalMs: 8_000,
    sleep: async ms => waits.push(ms) });
  await github.deleteRelease(1);
  await assert.rejects(github.deleteRelease(2), /finalization deadline/);
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
});

test('the finalization deadline aborts a stalled response body and prevents long retries', async () => {
  let calls = 0;
  let signal;
  const keepAlive = setTimeout(() => {}, 2_000);
  try {
    const github = client(async (_url, options) => {
      calls += 1;
      signal = options.signal;
      const stream = new ReadableStream({
        start(controller) {
          options.signal.addEventListener('abort', () => controller.error(options.signal.reason), { once: true });
        },
      });
      return new Response(stream);
    }, { deadline: Date.now() + 60, requestTimeoutMs: 60_000 });
    await assert.rejects(github.listReleases(), /finalization deadline|timed out/);
    assert.equal(signal.aborted, true);
    assert.equal(calls, 1);
  } finally { clearTimeout(keepAlive); }
});
