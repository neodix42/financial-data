import test from 'node:test';
import assert from 'node:assert/strict';
import { createState, resumeState, nextChunk, validateState, isComplete, makeIndex } from '../scripts/state.mjs';

const catalog = [
  { instrument: 'eurusd', category: 'Forex major currencies 💶', categorySlug: 'forex-major-currencies', starts: {
    h1: '2003-05-04T19:00:00.000Z', d1: '2000-01-01T00:00:00.000Z',
  } },
  { instrument: 'btcusd', category: 'Crypto assets ₿', categorySlug: 'crypto-assets', starts: {
    h1: '2017-05-07T21:00:00.000Z', d1: '2017-05-07T00:00:00.000Z',
  } },
];
const oldCutoff = '2026-10-24T00:00:00.000Z';
const newCutoff = '2026-10-31T00:00:00.000Z';

function pair(state, instrument, period) {
  return state.groups.find(group => group.period === period && group.pairs.some(item => item.instrument === instrument))
    .pairs.find(item => item.instrument === instrument);
}

function completePredecessor() {
  const state = createState(catalog, oldCutoff);
  state.releaseId = 101;
  state.tag = 'financial-data-previous';
  state.complete = true;
  for (const group of state.groups) for (const item of group.pairs) {
    item.cursor = oldCutoff;
    item.hasZip = true;
    item.zipSha256 = 'abc';
    item.summary = { first: item.start, last: '2026-10-23T00:00:00.000Z', rows: 10 };
  }
  return state;
}

test('H1 chunks stop at the next UTC month boundary, including leap February', () => {
  assert.deepEqual(nextChunk({ instrument: 'eurusd', cursor: '2024-02-29T23:00:00.000Z' }, 'h1', '2024-04-01T00:00:00.000Z'), {
    instrument: 'eurusd', period: 'h1', from: '2024-02-29T23:00:00.000Z', to: '2024-03-01T00:00:00.000Z',
  });
  assert.equal(nextChunk({ instrument: 'eurusd', cursor: '2024-12-15T04:00:00.000Z' }, 'h1', '2025-03-01T00:00:00.000Z').to,
    '2025-01-01T00:00:00.000Z');
});

test('D1 chunks stop at the next UTC year and both periods clamp to the snapshot cutoff', () => {
  const item = { instrument: 'eurusd', cursor: '2024-02-29T00:00:00.000Z' };
  assert.equal(nextChunk(item, 'd1', '2026-01-01T00:00:00.000Z').to, '2025-01-01T00:00:00.000Z');
  const cutoff = '2024-03-15T13:30:00.000Z';
  assert.equal(nextChunk({ ...item, cursor: '2024-03-01T00:00:00.000Z' }, 'h1', cutoff).to, cutoff);
  assert.equal(nextChunk(item, 'd1', cutoff).to, cutoff);
  assert.equal(nextChunk({ ...item, cursor: cutoff }, 'h1', cutoff), null);
  assert.equal(nextChunk({ ...item, cursor: '2025-01-01T00:00:00.000Z' }, 'd1', cutoff), null);
  assert.equal(nextChunk({ ...item, retired: true }, 'h1', cutoff), null);
});

test('new state preserves timeframe-specific clamped catalog starts', () => {
  const state = createState(catalog, oldCutoff);
  assert.equal(state.groups.length, 4);
  assert.equal(pair(state, 'eurusd', 'h1').cursor, catalog[0].starts.h1);
  assert.equal(pair(state, 'eurusd', 'd1').cursor, catalog[0].starts.d1);
  assert.equal(pair(state, 'btcusd', 'd1').cursor, catalog[1].starts.d1);
  assert.equal(isComplete(state), false);
  assert.doesNotThrow(() => validateState(state, catalog));
});

test('weekly reset refetches the last saved bar and empty histories resume from old cutoff', () => {
  const predecessor = completePredecessor();
  const empty = pair(predecessor, 'btcusd', 'd1');
  empty.summary = { first: null, last: null, rows: 0 };
  const state = createState(catalog, newCutoff, predecessor);
  assert.equal(pair(state, 'eurusd', 'h1').cursor, '2026-10-23T00:00:00.000Z');
  assert.equal(pair(state, 'btcusd', 'd1').cursor, oldCutoff);
  assert.equal(state.previousReleaseId, 101);
  assert.equal(state.previousTag, predecessor.tag);
  assert.equal(state.complete, false);
  pair(state, 'eurusd', 'h1').summary.rows = 99;
  assert.equal(pair(predecessor, 'eurusd', 'h1').summary.rows, 10);
});

test('resuming advances completed pairs to the new cutoff while keeping partial cursors', () => {
  const state = completePredecessor();
  pair(state, 'eurusd', 'h1').cursor = '2010-06-01T00:00:00.000Z';
  pair(state, 'btcusd', 'd1').summary = { first: null, last: null, rows: 0 };
  const resumed = resumeState(state, newCutoff, catalog);
  assert.equal(resumed, state);
  assert.equal(resumed.cutoff, newCutoff);
  assert.equal(resumed.complete, false);
  assert.equal(pair(resumed, 'eurusd', 'h1').cursor, '2010-06-01T00:00:00.000Z');
  assert.equal(pair(resumed, 'eurusd', 'd1').cursor, '2026-10-23T00:00:00.000Z');
  assert.equal(pair(resumed, 'btcusd', 'd1').cursor, oldCutoff);
  assert.equal(isComplete(resumed), false);
});

test('removed instruments retain archived histories and are retired without redownload', () => {
  const predecessor = completePredecessor();
  const reducedCatalog = [catalog[0]];
  const state = createState(reducedCatalog, newCutoff, predecessor);
  for (const period of ['h1', 'd1']) {
    const retired = pair(state, 'btcusd', period);
    assert.equal(retired.retired, true);
    assert.equal(retired.cursor, newCutoff);
    assert.equal(retired.hasZip, true);
    assert.equal(retired.summary.rows, 10);
    assert.equal(nextChunk(retired, period, newCutoff), null);
  }
  assert.doesNotThrow(() => validateState(state, reducedCatalog));
  const laterCutoff = '2026-11-07T00:00:00.000Z';
  resumeState(state, laterCutoff, reducedCatalog);
  assert.equal(pair(state, 'btcusd', 'h1').cursor, laterCutoff);
});

test('completion requires archives, and index distinguishes per-period coverage and no-data', () => {
  const state = completePredecessor();
  assert.equal(isComplete(state), true);
  pair(state, 'btcusd', 'd1').summary = { first: null, last: null, rows: 0 };
  pair(state, 'eurusd', 'h1').summary.last = '2026-10-23T23:00:00.000Z';
  const index = makeIndex(state);
  assert.match(index, /eurusd\th1\t[^\n]+\t2026-10-23T23:00:00.000Z\t10\tok\t/);
  assert.match(index, /btcusd\td1\t[^\n]+\t-\t-\t0\tno_data\t/);
  pair(state, 'eurusd', 'h1').hasZip = false;
  assert.equal(isComplete(state), false);
});

test('checkpoint validation rejects incompatible settings, missing pairs and backward cutoffs', () => {
  const state = createState(catalog, oldCutoff);
  assert.throws(() => resumeState(state, '2026-10-01T00:00:00.000Z', catalog), /precedes/);
  const incompatible = structuredClone(state);
  incompatible.priceType = 'ask';
  assert.throws(() => validateState(incompatible, catalog), /configuration differs/);
  const missing = structuredClone(state);
  missing.groups[0].pairs = [];
  assert.throws(() => validateState(missing, catalog), /missing/);
  assert.equal(resumeState(state, oldCutoff, catalog), state);
});
