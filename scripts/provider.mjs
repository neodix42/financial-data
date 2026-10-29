import {
  normaliseDates, generateUrls, BufferFetcher, processData, formatOutput,
} from 'dukascopy-node';

const columnNames = ['times', 'opens', 'highs', 'lows', 'closes', 'volumes'];
const periodMs = { h1: 3_600_000, d1: 86_400_000 };

function invalid(message) {
  throw new Error(`Invalid Dukascopy candle response: ${message}`);
}

/** Validate even empty responses before deciding that a bucket contains no bars. */
function providerTimestamps(data, period) {
  if (!data || !Number.isFinite(data.timestamp) || !Array.isArray(data.times)) {
    invalid('missing finite timestamp or times array');
  }
  for (const name of columnNames) {
    if (!Array.isArray(data[name]) || data[name].length !== data.times.length ||
        data[name].some(value => !Number.isFinite(value))) {
      invalid(`${name} must contain matching finite numeric values`);
    }
  }
  if (data.times.some(time => !Number.isInteger(time) || time < 0)) {
    invalid('time deltas must be non-negative integers');
  }
  if (data.times.length === 0) return new Set();
  if (['open', 'high', 'low', 'close', 'multiplier', 'shift'].some(name =>
    !Number.isFinite(data[name])) || data.multiplier <= 0 || data.shift !== periodMs[period]) {
    invalid('missing finite base candle, positive multiplier or matching timeframe shift');
  }

  let timestamp = data.timestamp;
  const actual = new Set();
  for (const delta of data.times) {
    // The API returns one month of H1 or one year of D1. Guard the upstream
    // gap-filling loop against malformed, unbounded time deltas.
    if (delta > (period === 'h1' ? 31 * 24 : 366)) invalid('time delta exceeds one provider bucket');
    timestamp += delta * data.shift;
    if (!Number.isFinite(timestamp) || !Number.isFinite(new Date(timestamp).getTime()) || actual.has(timestamp)) {
      invalid('invalid or repeated candle timestamp');
    }
    actual.add(timestamp);
  }
  return actual;
}

/**
 * Download one provider bucket through dukascopy-node's public components.
 * The optional fetcher is an object with fetch(urls), or an async function
 * returning the same [{ url, buffer }] records, for deterministic tests.
 *
 * v1.51.1 crashes when processing valid empty H1/D1 buckets and synthesizes flat
 * candles for missing intervals. Skip only validated empty buckets, then retain
 * only timestamps explicitly present in the provider's compressed response.
 */
export async function getBars(task, fetcher) {
  if (!Object.hasOwn(periodMs, task.period)) throw new Error('Only h1 and d1 provider tasks are supported');
  const from = new Date(task.from);
  const to = new Date(task.to);
  if (!Number.isFinite(+from) || !Number.isFinite(+to) || +from >= +to) {
    throw new Error('Provider task requires valid increasing datetime bounds');
  }
  const [startDate, endDate] = normaliseDates({
    instrument: task.instrument, startDate: from, endDate: to,
    timeframe: task.period, utcOffset: 0,
  });
  const urls = generateUrls({
    instrument: task.instrument, timeframe: task.period, priceType: 'bid', startDate, endDate,
  });
  if (urls.length === 0) return [];
  if (urls.length !== 1) throw new Error('Provider task must span at most one month of h1 or one year of d1');
  const transport = fetcher ?? new BufferFetcher({
    batchSize: 1, pauseBetweenBatchesMs: 0,
    retryCount: 3, pauseBetweenRetriesMs: 2000,
    retryOnEmpty: false, failAfterRetryCount: true,
    rateLimitRetryCount: 3, wafMode: 'auto',
  });
  const fetched = await (typeof transport === 'function' ? transport(urls) : transport.fetch(urls));
  if (!Array.isArray(fetched) || fetched.length !== urls.length ||
      fetched.some((item, index) => item?.url !== urls[index] || !Buffer.isBuffer(item.buffer))) {
    invalid('fetcher did not return every requested bucket');
  }
  const actual = new Set();
  const nonempty = [];
  for (const item of fetched) {
    let raw;
    try { raw = JSON.parse(item.buffer.toString('utf8')); }
    catch { invalid('response is not JSON'); }
    const timestamps = providerTimestamps(raw, task.period);
    if (timestamps.size === 0) continue;
    nonempty.push(item);
    for (const timestamp of timestamps) actual.add(timestamp);
  }
  if (nonempty.length === 0) return [];
  const processed = processData({
    instrument: task.instrument, requestedTimeframe: task.period, bufferObjects: nonempty,
    priceType: 'bid', volumes: true, volumeUnits: 'millions', ignoreFlats: false,
  }).filter(([timestamp]) => actual.has(timestamp) && timestamp >= +from && timestamp < +to);
  return formatOutput({ processedData: processed, format: 'json', timeframe: task.period });
}
