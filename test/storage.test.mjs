import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  CSV_HEADER, mergeBars, inspectCsv, zipCsv, unzipCsv, packFiles, extractTar, sha256,
} from '../scripts/storage.mjs';

const start = Date.parse('2020-01-01T00:00:00.000Z');
const hour = 3_600_000;
const bar = (hours, close = 2) => ({ timestamp: start + hours * hour, open: 2, high: 4, low: 1, close, volume: 5 });
const options = { from: start, cutoff: start + 10 * hour, period: 'h1' };

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'financial-storage-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('overlap replaces a latest bar, deduplicates new bars and excludes the forming bar', async t => {
  const directory = await temporary(t);
  const csv = join(directory, 'eurusd-h1.csv');
  const original = await mergeBars(csv, [bar(0), bar(1)], options);
  const summary = await mergeBars(csv, [bar(2, 3), bar(1, 3), bar(2, 4), bar(3)], {
    from: start + hour,
    cutoff: start + 3.5 * hour,
    period: 'h1',
    summary: original,
  });
  assert.equal(summary.rows, 3);
  assert.equal(summary.first, '2020-01-01T00:00:00.000Z');
  assert.equal(summary.last, '2020-01-01T02:00:00.000Z');
  assert.deepEqual(await inspectCsv(csv), summary);
  const contents = await readFile(csv, 'utf8');
  assert.match(contents, /2020-01-01T01:00:00.000Z,2,4,1,3,5/);
  assert.match(contents, /2020-01-01T02:00:00.000Z,2,4,1,4,5/);
  assert.doesNotMatch(contents, /03:00:00/);
});

test('wider overlap merges timestamps while retaining old bars absent from the response', async t => {
  const directory = await temporary(t);
  const csv = join(directory, 'eurusd-h1.csv');
  await mergeBars(csv, [bar(0), bar(2), bar(4)], options);
  const summary = await mergeBars(csv, [bar(1), bar(2, 3), bar(3)], options);
  assert.equal(summary.rows, 5);
  assert.equal(summary.last, '2020-01-01T04:00:00.000Z');
  assert.deepEqual(await inspectCsv(csv), summary);
});

test('append offsets remain correct beyond stream boundaries and after shortening a replacement row', async t => {
  const directory = await temporary(t);
  const csv = join(directory, 'eurusd-h1.csv');
  const lines = Array.from({ length: 5000 }, (_, index) => `${new Date(start + index * hour).toISOString()},2,4,1,2,123456789\n`);
  await writeFile(csv, CSV_HEADER + lines.join(''));
  const previous = await inspectCsv(csv);
  assert.ok(previous.bytes > 65_536);
  const replaced = await mergeBars(csv, [bar(4999)], {
    from: start + 4999 * hour,
    cutoff: start + 5001 * hour,
    period: 'h1',
    summary: previous,
  });
  assert.equal(replaced.rows, 5000);
  assert.ok(replaced.bytes < previous.bytes);
  assert.deepEqual(await inspectCsv(csv), replaced);
  const appended = await mergeBars(csv, [bar(5000)], {
    from: start + 5000 * hour,
    cutoff: start + 5001 * hour,
    period: 'h1',
    summary: replaced,
  });
  assert.equal(appended.rows, 5001);
  assert.deepEqual(await inspectCsv(csv), appended);
});

test('empty history produces only a header and empty refresh preserves history', async t => {
  const directory = await temporary(t);
  const csv = join(directory, 'eurusd-h1.csv');
  const empty = await mergeBars(csv, [], options);
  assert.equal(empty.rows, 0);
  assert.equal(empty.first, null);
  assert.equal(empty.last, null);
  assert.equal(await readFile(csv, 'utf8'), CSV_HEADER);
  const populated = await mergeBars(csv, [bar(0)], { ...options, summary: empty });
  assert.deepEqual(await mergeBars(csv, [], { ...options, summary: populated }), populated);
});

test('D1 closes at a full day and incoming invalid bars leave history unchanged', async t => {
  const directory = await temporary(t);
  const csv = join(directory, 'eurusd-d1.csv');
  await mergeBars(csv, [bar(0), bar(24)], { ...options, cutoff: start + 36 * hour, period: 'd1' });
  const original = await readFile(csv, 'utf8');
  assert.equal((await inspectCsv(csv)).rows, 1);
  await assert.rejects(mergeBars(csv, [{ ...bar(1), volume: NaN }], options), /Non-finite/);
  await assert.rejects(mergeBars(csv, [{ ...bar(1), low: 9 }], options), /OHLCV range/);
  assert.equal(await readFile(csv, 'utf8'), original);
});

test('inspection rejects unsorted, duplicate and truncated CSV histories', async t => {
  const directory = await temporary(t);
  const csv = join(directory, 'eurusd-h1.csv');
  await mergeBars(csv, [bar(0)], options);
  const row = (await readFile(csv, 'utf8')).slice(CSV_HEADER.length);
  await writeFile(csv, CSV_HEADER + row + row);
  await assert.rejects(inspectCsv(csv), /ascending and unique/);
  await writeFile(csv, (CSV_HEADER + row).trimEnd());
  await assert.rejects(inspectCsv(csv), /newline/);
});

test('CSV ZIP and split category TAR round trip with checksums', async t => {
  const directory = await temporary(t);
  const source = join(directory, 'eurusd-h1.csv');
  await mergeBars(source, [bar(0), bar(1)], options);
  const zip = join(directory, 'eurusd-h1.zip');
  await zipCsv(source, zip);
  const unzipped = await unzipCsv(zip, join(directory, 'csv'), 'eurusd-h1.csv');
  assert.equal(await readFile(unzipped, 'utf8'), await readFile(source, 'utf8'));

  const extra = join(directory, 'checkpoint.json');
  await writeFile(extra, 'x'.repeat(12_000));
  const other = join(directory, 'another.zip');
  await writeFile(other, 'x'.repeat(12_000));
  const bundles = await packFiles([zip, extra, other], join(directory, 'bundles'), 'forex-currencies-h1', { maxBytes: 20_480 });
  assert.equal(bundles.length, 2);
  assert.equal(bundles[0].name, 'forex-currencies-h1-part001.tar');
  const destination = join(directory, 'restored');
  for (const bundle of bundles) {
    assert.ok(bundle.size <= 20_480);
    assert.equal(await sha256(bundle.path), bundle.sha256);
    await extractTar(bundle.path, destination, { allowedNames: ['eurusd-h1.zip', 'checkpoint.json', 'another.zip'] });
  }
  assert.equal(await sha256(join(destination, 'eurusd-h1.zip')), await sha256(zip));
  assert.equal(await readFile(join(destination, 'checkpoint.json'), 'utf8'), 'x'.repeat(12_000));
});

test('archive extraction rejects unexpected names and symbolic links', async t => {
  const directory = await temporary(t);
  const input = join(directory, 'safe.txt');
  await writeFile(input, 'data');
  const [bundle] = await packFiles([input], join(directory, 'bundles'), 'safe');
  await assert.rejects(extractTar(bundle.path, join(directory, 'unexpected'), { allowedNames: ['other.txt'] }), /Unexpected/);
  const links = join(directory, 'links');
  await mkdir(links);
  execFileSync('ln', ['-s', '/etc/passwd', join(links, 'unsafe')]);
  const archive = join(directory, 'unsafe.tar');
  execFileSync('tar', ['-cf', archive, '-C', links, 'unsafe']);
  await assert.rejects(extractTar(archive, join(directory, 'extracted')), /regular files only/);
});

test('packing refuses an oversized single member and duplicate basenames', async t => {
  const directory = await temporary(t);
  const input = join(directory, 'large.zip');
  await writeFile(input, 'x'.repeat(30_000));
  await assert.rejects(packFiles([input], directory, 'large', { maxBytes: 20_480 }), /Single member/);
  await assert.rejects(packFiles([input, input], directory, 'duplicate'), /Duplicate/);
});
