import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { confirmUnavailable } from '../scripts/availability.mjs';

const ROOT = 'https://jetta.dukascopy.com/v1/instruments';
const metadata = { removed: { code: 'AHT.GB-GBX' }, supported: { code: 'EUR-USD' }, other: { code: 'CCL.GB-GBX' } };
const catalog = () => ({ instruments: [{ id: 1, code: 'EUR-USD' }], groups: [], platformGroups: [], sectors: [], webGroups: [], platforms: {} });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const options = fetchImpl => ({ fetchImpl, sessionPath: '/nonexistent-financial-data-test-session', metadata });

test('a listed instrument is available without querying its detail endpoint', async () => {
  const calls = [];
  const result = await confirmUnavailable('supported', options(async url => {
    calls.push(url); return json(catalog());
  }));
  assert.equal(result, null);
  assert.deepEqual(calls, [ROOT]);
});

test('absence plus exact Unknown instrument response confirms unavailability and caches only the catalog', async () => {
  const calls = [];
  const opts = options(async url => {
    calls.push(url);
    return url === ROOT ? json(catalog()) : json({ error: 'Unknown instrument' }, 400);
  });
  const first = await confirmUnavailable('removed', opts);
  const second = await confirmUnavailable('other', opts);
  assert.equal(first.code, 'AHT.GB-GBX');
  assert.match(first.reason, /Unknown instrument/);
  assert.equal(first.source, `${ROOT}/AHT.GB-GBX`);
  assert.ok(Number.isFinite(Date.parse(first.checkedAt)));
  assert.equal(second.code, 'CCL.GB-GBX');
  assert.deepEqual(calls, [ROOT, `${ROOT}/AHT.GB-GBX`, `${ROOT}/CCL.GB-GBX`]);
});

test('a missing catalog entry with a valid detail response is not classified unavailable', async () => {
  const result = await confirmUnavailable('removed', options(async url =>
    url === ROOT ? json(catalog()) : json({ code: 'AHT.GB-GBX' })));
  assert.equal(result, null);
});

test('WAF, server and permission failures never establish absence or poison catalog recovery', async () => {
  for (const status of [202, 403, 429, 500]) {
    let calls = 0;
    const opts = options(async url => {
      calls += 1;
      if (calls === 1) return new Response(null, { status });
      return url === ROOT ? json(catalog()) : json({ error: 'Unknown instrument' }, 400);
    });
    await assert.rejects(confirmUnavailable('removed', opts), error => error.status === status);
    assert.equal((await confirmUnavailable('removed', opts)).code, 'AHT.GB-GBX');
    assert.equal(calls, 3);
  }
});

test('malformed, partial and duplicate catalogs never establish absence', async () => {
  for (const value of [
    {}, { instruments: [] }, { ...catalog(), instruments: [] }, { ...catalog(), platforms: [] },
    { ...catalog(), hasMore: true }, { ...catalog(), total: 2 },
    { ...catalog(), next: 'another-page' },
    { ...catalog(), instruments: [{ code: 'EUR-USD' }] },
    { ...catalog(), instruments: [{ id: 1, code: 'EUR-USD' }, { id: 2, code: 'EUR-USD' }] },
    { ...catalog(), instruments: [{ id: 1, code: 'EUR-USD' }, { id: 1, code: 'USD-JPY' }] },
  ]) {
    await assert.rejects(confirmUnavailable('removed', options(async () => json(value))), /Invalid/);
  }
  await assert.rejects(confirmUnavailable('removed', options(async () => new Response('not json'))), /invalid JSON/);
});

test('arbitrary detail errors and malformed detail JSON are not treated as removed symbols', async () => {
  for (const [status, detail] of [
    [400, { error: 'Bad date' }], [404, { error: 'Not found' }],
    [403, { error: 'Forbidden' }], [500, { error: 'Server error' }],
    [200, { code: 'SOME-OTHER-CODE' }],
  ]) {
    await assert.rejects(confirmUnavailable('removed', options(async url =>
      url === ROOT ? json(catalog()) : json(detail, status))));
  }
  await assert.rejects(confirmUnavailable('removed', options(async url =>
    url === ROOT ? json(catalog()) : new Response('not json', { status: 400 }))), /invalid JSON/);
});

test('reuses a valid same-origin provider WAF session without redirects or exposing it in evidence', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'financial-availability-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessionPath = join(directory, 'session.json');
  await writeFile(sessionPath, JSON.stringify({ version: 2, origin: 'https://jetta.dukascopy.com', token: 'test-token', userAgent: 'Test Browser' }));
  const evidence = await confirmUnavailable('removed', { metadata, sessionPath, fetchImpl: async (url, request) => {
    assert.equal(request.headers.cookie, 'aws-waf-token=test-token');
    assert.equal(request.headers['user-agent'], 'Test Browser');
    assert.equal(request.redirect, 'error');
    assert.ok(request.signal instanceof AbortSignal);
    return url === ROOT ? json(catalog()) : json({ error: 'Unknown instrument' }, 400);
  } });
  assert.doesNotMatch(JSON.stringify(evidence), /test-token|Test Browser/);

  await writeFile(sessionPath, JSON.stringify({ version: 2, origin: 'https://another.example', token: 'do-not-forward', userAgent: 'Wrong Origin' }));
  await confirmUnavailable('supported', { metadata, sessionPath, fetchImpl: async (_url, request) => {
    assert.equal(request.headers.cookie, undefined);
    assert.notEqual(request.headers['user-agent'], 'Wrong Origin');
    return json(catalog());
  } });
});

test('unknown pinned IDs cannot accidentally verify another instrument', async () => {
  await assert.rejects(confirmUnavailable('missing', options(async () => assert.fail('must not fetch'))), /Unknown pinned instrument/);
});
