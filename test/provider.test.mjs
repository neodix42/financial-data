import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getBars } from '../scripts/provider.mjs';
import { mergeBars, inspectCsv, CSV_HEADER } from '../scripts/storage.mjs';

const task = {
  instrument: 'eurusd', period: 'h1',
  from: '2020-01-01T00:00:00.000Z', to: '2020-02-01T00:00:00.000Z',
};
const hour = 3_600_000;
const timestamp = Date.parse(task.from);
const response = () => ({
  timestamp, multiplier: 0.1, shift: hour,
  open: 1, high: 1, low: 1, close: 1,
  times: [0, 3], opens: [0, 0], highs: [0, 0], lows: [0, 0], closes: [0, 0], volumes: [0, 4],
});
const empty = () => ({ timestamp, times: [], opens: [], highs: [], lows: [], closes: [], volumes: [] });
const fetcher = data => async urls => urls.map(url => ({ url, buffer: Buffer.from(JSON.stringify(data)) }));

test('accepts a validated empty provider bucket without invoking crashing upstream aggregation', async () => {
  assert.deepEqual(await getBars(task, fetcher(empty())), []);
  assert.deepEqual(await getBars({ ...task, period: 'd1', to: '2021-01-01T00:00:00.000Z' }, fetcher(empty())), []);
});

test('keeps real zero-volume flat candles and removes only synthesized gap candles', async () => {
  const bars = await getBars(task, fetcher(response()));
  assert.deepEqual(bars, [
    { timestamp, open: 1, high: 1, low: 1, close: 1, volume: 0 },
    { timestamp: timestamp + 3 * hour, open: 1, high: 1, low: 1, close: 1, volume: 4 },
  ]);
});

test('filters opening timestamps against exact inclusive-from exclusive-to bounds', async () => {
  const bars = await getBars({ ...task, from: new Date(timestamp + hour).toISOString(),
    to: new Date(timestamp + 4 * hour).toISOString() }, fetcher(response()));
  assert.deepEqual(bars.map(bar => bar.timestamp), [timestamp + 3 * hour]);
  assert.deepEqual(await getBars({ ...task, to: new Date(timestamp + 3 * hour).toISOString() }, fetcher(response())), [
    { timestamp, open: 1, high: 1, low: 1, close: 1, volume: 0 },
  ]);
});

test('USD/CNH repeated daily timestamps decode fully and merge into valid compact rows', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'financial-provider-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dailyTask = {
    instrument: 'usdcnh', period: 'd1',
    from: '2012-01-02T21:00:00.000Z', to: '2013-01-01T00:00:00.000Z',
  };
  const june26 = Date.parse('2012-06-26T00:00:00.000Z');
  const day = 86_400_000;
  // Exact June 26–28 source rows from USD-CNH/BID/2012. The duplicate rows
  // replace invalid zero-volume legacy values; their deltas must still decode.
  const raw = {
    timestamp: june26, multiplier: 0.00001, shift: day,
    open: 6.3729, high: 6.3644, low: 6.3495, close: 6.3712,
    times: [0, 0, 1, 0, 1],
    opens: [0, -1084, 494, -472, -272],
    highs: [0, -193, -67, 158, -99],
    lows: [0, 1210, -1210, -296, 257],
    closes: [0, -895, 215, -398, -732],
    volumes: [0, 2439, 0, 43.95, 44.4],
  };
  const bars = await getBars(dailyTask, fetcher(raw));
  assert.deepEqual(bars.map(bar => bar.timestamp), [june26, june26, june26 + day, june26 + day, june26 + 2 * day]);
  assert.deepEqual(bars.at(-1), {
    timestamp: june26 + 2 * day, open: 6.35956, high: 6.36239,
    low: 6.34911, close: 6.3531, volume: 44.4,
  });
  const csv = join(directory, 'usdcnh-d1.csv');
  const warnings = [];
  const summary = await mergeBars(csv, bars, {
    from: dailyTask.from, cutoff: dailyTask.to, period: 'd1',
    onWarning: warning => warnings.push(warning),
  });
  assert.equal(summary.rows, 3);
  assert.deepEqual(await inspectCsv(csv), summary);
  assert.equal(await readFile(csv, 'utf8'), CSV_HEADER +
    '2012-06-26T00:00:00.000Z,6.36206,6.36247,6.3616,6.36225,2439\n' +
    '2012-06-27T00:00:00.000Z,6.36228,6.36338,6.34654,6.36042,43.95\n' +
    '2012-06-28T00:00:00.000Z,6.35956,6.36239,6.34911,6.3531,44.4\n');
  assert.match(warnings[0], /omitted 2 invalid OHLCV/);
});

test('rejects malformed empty responses instead of marking missing history successful', async () => {
  for (const data of [
    {}, { ...empty(), timestamp: null }, { ...empty(), opens: [1] },
    { ...empty(), volumes: undefined }, { ...empty(), times: 'empty' },
  ]) await assert.rejects(getBars(task, fetcher(data)), /Invalid Dukascopy candle response/);
});

test('rejects malformed numeric columns and invalid candle encoding', async () => {
  for (const data of [
    { ...response(), highs: [0, null] }, { ...response(), opens: [0] },
    { ...response(), shift: 0 }, { ...response(), multiplier: -1 },
    { ...response(), open: null }, { ...response(), times: [0, -1] },
    { ...response(), timestamp: 8_640_000_000_000_001 },
    { ...response(), times: [0, 10_000_000] },
  ]) await assert.rejects(getBars(task, fetcher(data)), /Invalid Dukascopy candle response/);
});

test('rejects incomplete fetch results, invalid JSON and provider failures', async () => {
  await assert.rejects(getBars(task, async () => []), /every requested bucket/);
  await assert.rejects(getBars(task, async urls => [{ url: urls[0], buffer: Buffer.from('not json') }]), /not JSON/);
  const failure = Object.assign(new Error('denied'), { code: 'DUKASCOPY_ACCESS_DENIED' });
  await assert.rejects(getBars(task, async () => { throw failure; }), error => error === failure);
});

test('requires a single bucket and a supported period', async () => {
  await assert.rejects(getBars({ ...task, to: '2020-03-01T00:00:00.000Z' }, fetcher(empty())), /at most one/);
  await assert.rejects(getBars({ ...task, period: 'm1' }, fetcher(empty())), /Only h1 and d1/);
  await assert.rejects(getBars({ ...task, from: task.to }, fetcher(empty())), /increasing datetime/);
});

test('HTTP 400 becomes unavailable only after an explicit provider availability confirmation', async () => {
  const failure = new Error('Request failed with status 400 for a candle URL');
  const transport = async () => { throw failure; };
  const availability = { code: 'AHT.GB-GBX', reason: 'Unknown instrument',
    source: 'https://jetta.dukascopy.com/v1/instruments', checkedAt: '2026-10-31T00:00:00.000Z' };
  await assert.rejects(getBars(task, transport, { availabilityChecker: async instrument => {
    assert.equal(instrument, task.instrument);
    return availability;
  } }), error => error.code === 'DUKASCOPY_INSTRUMENT_UNAVAILABLE' && error.availability === availability);
  await assert.rejects(getBars(task, transport, { availabilityChecker: async () => null }), error => error === failure);
  const denied = new Error('Request failed with status 403 for a candle URL');
  await assert.rejects(getBars(task, async () => { throw denied; }, {
    availabilityChecker: async () => assert.fail('Access denied is not evidence of a withdrawn instrument'),
  }), error => error === denied);
  await assert.rejects(getBars(task, transport, {
    availabilityChecker: async () => { throw new Error('Catalog check failed'); },
  }), /Catalog check failed/);
});
