import assert from 'node:assert/strict';
import test from 'node:test';
import { getBars } from '../scripts/provider.mjs';

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
    { ...response(), times: [0, 0] }, { ...response(), times: [0, 10_000_000] },
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
