import assert from 'node:assert/strict';
import test from 'node:test';
import { instrumentMetaData } from 'dukascopy-node';
import { buildCatalog, categories } from '../scripts/catalog.mjs';

test('every supported instrument belongs to exactly one authoritative category', () => {
  const assigned = categories.flatMap(category => category.instruments);
  assert.equal(assigned.length, 1499);
  assert.equal(new Set(assigned).size, assigned.length);
  assert.deepEqual([...assigned].sort(), Object.keys(instrumentMetaData).sort());
  const catalog = buildCatalog(instrumentMetaData);
  assert.equal(catalog.length, 1499);
  assert.deepEqual(catalog.map(row => row.instrument), Object.keys(instrumentMetaData).sort());
  assert.equal(new Set(catalog.map(row => row.categorySlug)).size, 39);
});

test('user category labels and membership counts match the pinned upstream list', () => {
  const expected = {
    'Bonds 📊': 3, 'ETFs 📈': 17, 'Crypto assets ₿': 29,
    'Agricultural commodities ☕': 6, 'Energy commodities ⚡': 4, 'Metals commodities ⚙️': 3,
    'Germany ETFs 🇩🇪📈': 1, 'France ETFs 🇫🇷📈': 3, 'Hong Kong ETFs 🇭🇰📈': 4,
    'United States ETFs 🇺🇸📈': 60, 'Forex currencies 💱': 290,
    'Forex major currencies 💶': 7, 'Forex metals 🥇': 51,
    'Africa 🌍': 1, 'America 🌎': 6, 'Asia 🌏': 5, 'Europe 🇪🇺': 9,
    'Austria 🇦🇹': 3, 'Belgium 🇧🇪': 7, 'Denmark 🇩🇰': 8, 'Finland 🇫🇮': 7,
    'France 🇫🇷': 38, 'Germany 🇩🇪': 43, 'Hong Kong 🇭🇰': 26, 'Ireland 🇮🇪': 4,
    'Italy 🇮🇹': 38, 'Japan 🇯🇵': 53, 'Mexico 🇲🇽': 28, 'Netherlands 🇳🇱': 15,
    'Norway 🇳🇴': 5, 'Portugal 🇵🇹': 2, 'Spain 🇪🇸': 19, 'Sweden 🇸🇪': 18,
    'Switzerland 🇨🇭': 25, 'United Kingdom 🇬🇧': 104, 'United States 🇺🇸': 546,
    'Crypto Curr': 1, 'Mutual Funds': 9, 'Ungrouped': 1,
  };
  assert.deepEqual(Object.fromEntries(categories.map(category => [category.name, category.instruments.length])), expected);
});

test('history start is timeframe-specific and clamped to January 2000', () => {
  const eurusd = buildCatalog({ eurusd: instrumentMetaData.eurusd })[0];
  assert.equal(eurusd.category, 'Forex major currencies 💶');
  assert.equal(eurusd.categorySlug, 'forex-major-currencies');
  assert.equal(eurusd.starts.h1, '2003-05-04T19:00:00.000Z');
  assert.equal(eurusd.starts.d1, '2000-01-01T00:00:00.000Z');
});

test('new instruments are retained under Ungrouped rather than silently omitted', () => {
  const result = buildCatalog({ newasset: instrumentMetaData.eurusd });
  assert.equal(result[0].category, 'Ungrouped');
  assert.equal(result[0].categorySlug, 'ungrouped');
});

test('rejects unsafe instrument names and malformed history bounds', () => {
  assert.throws(() => buildCatalog({ '../escape': instrumentMetaData.eurusd }), /Unsafe instrument/);
  assert.throws(() => buildCatalog({ eurusd: {} }), /Missing or invalid/);
});
