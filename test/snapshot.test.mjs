import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runSnapshot } from '../scripts/snapshot.mjs';
import { MARKER, TAG_PREFIX } from '../scripts/state.mjs';
import { extractTar, unzipCsv, inspectCsv } from '../scripts/storage.mjs';

const start = '2026-01-01T00:00:00.000Z';
const catalog = ['eurusd', 'gbpusd'].map(instrument => ({
  instrument, category: 'Forex major currencies 💶', categorySlug: 'forex-major-currencies',
  starts: { h1: start, d1: start },
}));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const metadata = asset => {
  const { bytes, ...publicFields } = asset;
  return structuredClone(publicFields);
};

class FakeGitHub {
  constructor() {
    this.releases = [];
    this.assets = new Map();
    this.events = [];
    this.nextId = 1;
    this.failUpload = null;
    this.failPublish = false;
    this.failRename = null;
  }
  async listReleases() { return structuredClone(this.releases); }
  async listAssets(releaseId) { return (this.assets.get(releaseId) ?? []).map(metadata); }
  async createDraft({ tag, body }) {
    const id = this.nextId++;
    const release = { id, tag_name: tag, body, draft: true, prerelease: false,
      created_at: new Date(Date.parse('2026-01-01T00:00:00Z') + id * 1_000).toISOString(),
      upload_url: `https://uploads.github.com/repos/owner/repo/releases/${id}/assets{?name,label}` };
    this.releases.push(release);
    this.assets.set(id, []);
    this.events.push({ type: 'create', id });
    return structuredClone(release);
  }
  async uploadAsset(release, path, name) {
    if (this.failUpload?.({ release, path, name })) throw new Error(`Simulated upload failure: ${name}`);
    const bytes = await readFile(path);
    const assets = this.assets.get(release.id);
    assert.ok(assets, 'upload targets an existing release');
    assert.ok(!assets.some(asset => asset.name === name), `duplicate upload: ${name}`);
    const asset = { id: this.nextId++, name, state: 'uploaded', size: bytes.length,
      digest: `sha256:${hash(bytes)}`, bytes };
    assets.push(asset);
    this.events.push({ type: 'upload', releaseId: release.id, name, id: asset.id });
    return metadata(asset);
  }
  async downloadAsset(asset, destination) {
    const stored = [...this.assets.values()].flat().find(item => item.id === asset.id);
    assert.ok(stored, `download references retained asset ${asset.id}`);
    await mkdir(join(destination, '..'), { recursive: true });
    await writeFile(destination, stored.bytes);
    this.events.push({ type: 'download', id: asset.id });
    return { path: destination, size: stored.size, sha256: hash(stored.bytes) };
  }
  async deleteAsset(id) {
    for (const [releaseId, assets] of this.assets) this.assets.set(releaseId, assets.filter(asset => asset.id !== id));
    this.events.push({ type: 'deleteAsset', id });
  }
  async renameAsset(id, name) {
    const assets = [...this.assets.values()].find(items => items.some(item => item.id === id));
    const asset = assets?.find(item => item.id === id);
    assert.ok(asset, `rename references retained asset ${id}`);
    if (this.failRename?.({ asset, name })) throw new Error(`Simulated rename interruption: ${name}`);
    assert.ok(!assets.some(item => item.id !== id && item.name === name), `duplicate renamed asset: ${name}`);
    asset.name = name;
    this.events.push({ type: 'rename', id, name });
    return metadata(asset);
  }
  async publish(id) {
    if (this.failPublish) throw new Error('Simulated interruption before publication');
    const release = this.releases.find(item => item.id === id);
    assert.ok(release?.draft, 'only a draft is published');
    release.draft = false;
    this.events.push({ type: 'publish', id });
    return structuredClone(release);
  }
  async getRelease(id) {
    const release = this.releases.find(item => item.id === id);
    assert.ok(release, `release ${id} exists`);
    this.events.push({ type: 'getRelease', id });
    return structuredClone(release);
  }
  async deleteRelease(id) {
    this.events.push({ type: 'deleteRelease', id });
    this.releases = this.releases.filter(release => release.id !== id);
    this.assets.delete(id);
  }
  asset(releaseId, name) { return this.assets.get(releaseId).find(asset => asset.name === name); }
  manifest(releaseId) { return JSON.parse(this.asset(releaseId, 'manifest.json').bytes.toString()); }
  checkpoint(releaseId) {
    const latest = this.assets.get(releaseId).filter(asset => /^checkpoint-\d{8}\.json$/.test(asset.name))
      .sort((a, b) => b.name.localeCompare(a.name))[0];
    return JSON.parse(latest.bytes.toString());
  }
}

function bar(timestamp, value = 1) {
  return { timestamp: Date.parse(timestamp), open: value, high: value + 0.2,
    low: value - 0.2, close: value + 0.1, volume: 10 };
}

function poolProvider({ rows, tasks = [], onTask = () => {} }) {
  return () => ({
    async download(task) {
      tasks.push(structuredClone(task));
      const injected = onTask(task);
      if (injected) return injected;
      return { bars: rows.filter(item => item.timestamp >= Date.parse(task.from) && item.timestamp < Date.parse(task.to)) };
    },
    async stop() {},
  });
}

async function snapshot(client, directory, options = {}) {
  return runSnapshot({ client, catalog, workDirectory: directory, parallel: 2,
    cutoff: '2026-01-03T00:00:00.000Z', budgetMs: 60_000, checkpointMs: 60_000,
    log: () => {}, ...options });
}

async function readInstrument(client, releaseId, instrument, period, directory) {
  const manifest = client.manifest(releaseId);
  const group = manifest.groups.find(item => item.period === period);
  const pair = group.pairs.find(item => item.instrument === instrument);
  const archive = client.asset(releaseId, pair.bundle);
  const tar = join(directory, `${period}.tar`);
  const extracted = join(directory, `${instrument}-${period}`);
  await mkdir(directory, { recursive: true });
  await writeFile(tar, archive.bytes);
  await extractTar(tar, extracted);
  const csv = await unzipCsv(join(extracted, `${instrument}-${period}.zip`), extracted, `${instrument}-${period}.csv`);
  return { text: await readFile(csv, 'utf8'), summary: await inspectCsv(csv), pair };
}

test('publishes complete real archives and index; weekly refresh replaces overlap before deleting predecessor', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'financial-snapshot-'));
  try {
    const client = new FakeGitHub();
    const initialRows = [bar(start), bar('2026-01-02T00:00:00Z')];
    const first = await snapshot(client, join(directory, 'first'), { poolFactory: poolProvider({ rows: initialRows }) });
    assert.equal(first.status, 'published');
    assert.equal(client.releases.length, 1);
    assert.equal(client.releases[0].draft, false);
    const index = client.asset(first.releaseId, 'index.txt').bytes.toString();
    const indexRows = index.trimEnd().split('\n').slice(2);
    assert.equal(indexRows.length, catalog.length * 2);
    assert.match(index, /eurusd\th1\tForex major currencies 💶\t2026-01-01T00:00:00.000Z\t2026-01-02T00:00:00.000Z\t2\tok/);
    assert.ok(client.assets.get(first.releaseId).every(asset => !asset.name.startsWith('checkpoint-')));
    const publicArchives = client.assets.get(first.releaseId).filter(asset => asset.name.endsWith('.tar'));
    assert.ok(publicArchives.every(asset => !/-v\d+-part/.test(asset.name)), 'published category filenames omit checkpoint revisions');
    assert.ok(publicArchives.every(asset => index.includes(asset.name)), 'the public index refers to finalized archive names');
    const firstStored = await readInstrument(client, first.releaseId, 'eurusd', 'h1', join(directory, 'first-read'));
    assert.equal(firstStored.summary.rows, 2);

    const tasks = [];
    const updatedRows = [bar(start), bar('2026-01-02T00:00:00Z', 2), bar('2026-01-03T00:00:00Z', 3)];
    const second = await snapshot(client, join(directory, 'second'), {
      cutoff: '2026-01-04T00:00:00.000Z',
      poolFactory: poolProvider({ rows: updatedRows, tasks }),
    });
    assert.equal(second.status, 'published');
    assert.notEqual(second.releaseId, first.releaseId);
    assert.equal(client.releases.length, 1);
    assert.equal(client.releases[0].id, second.releaseId);
    assert.ok(tasks.every(task => task.from === '2026-01-02T00:00:00.000Z'), 'update starts inclusively from the last stored bar');
    const updated = await readInstrument(client, second.releaseId, 'eurusd', 'h1', join(directory, 'second-read'));
    assert.equal(updated.summary.rows, 3);
    assert.equal(updated.summary.last, '2026-01-03T00:00:00.000Z');
    assert.match(updated.text, /2026-01-02T00:00:00.000Z,2,2.2,1.8,2.1,10/);
    assert.ok(client.events.findIndex(event => event.type === 'publish' && event.id === second.releaseId) <
      client.events.findIndex(event => event.type === 'deleteRelease' && event.id === first.releaseId));
    assert.ok(client.events.findIndex(event => event.type === 'getRelease' && event.id === second.releaseId) <
      client.events.findIndex(event => event.type === 'deleteRelease' && event.id === first.releaseId));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('bad source OHLC candles are omitted from compact CSV files and incremental updates keep original timestamps', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'financial-source-ohlc-'));
  try {
    const client = new FakeGitHub();
    const sourceCatalog = [{
      instrument: 'usatechidxusd', category: 'America 🌎', categorySlug: 'america',
      starts: { h1: '2000-01-01T00:00:00.000Z', d1: '2000-01-01T00:00:00.000Z' },
    }];
    // Exact values from the provider's USATECH.IDX-USD/BID/2000 response:
    // April 3 opens above its reported high; April 7 opens below its low.
    const sourceRows = [
      { timestamp: Date.parse('2000-04-03T00:00:00.000Z'), open: 4397.84,
        high: 4355.7, low: 4041.24, close: 4077.02, volume: 0 },
      { timestamp: Date.parse('2000-04-07T00:00:00.000Z'), open: 4086.73,
        high: 4292.88, low: 4111.18, close: 4291.53, volume: 0 },
      bar('2000-12-29T00:00:00.000Z', 2700),
    ];
    const logs = [];
    const first = await snapshot(client, join(directory, 'initial'), {
      catalog: sourceCatalog, cutoff: '2001-01-01T00:00:00.000Z',
      poolFactory: poolProvider({ rows: sourceRows }), log: message => logs.push(message),
    });
    assert.equal(first.status, 'published');
    const stored = await readInstrument(client, first.releaseId, 'usatechidxusd', 'd1', join(directory, 'initial-read'));
    assert.equal(stored.summary.rows, 1, 'bad provider candles must not enter the archive');
    const sourceLines = [
      '2000-04-03T00:00:00.000Z,4397.84,4355.7,4041.24,4077.02,0',
      '2000-04-07T00:00:00.000Z,4086.73,4292.88,4111.18,4291.53,0',
    ];
    for (const line of sourceLines) assert.ok(!stored.text.split('\n').includes(line), 'bad OHLC values must be omitted instead of clamped');
    const initialLines = stored.text.trimEnd().split('\n');
    assert.equal(initialLines.length, 2, 'CSV contains only its header and valid bars, without gap placeholders');
    assert.ok(initialLines.every(line => line.length > 0), 'removing bad bars must not leave blank CSV rows');
    assert.equal(initialLines[1].split(',')[0], '2000-12-29T00:00:00.000Z', 'valid bar timestamps must not be shifted');
    assert.ok(logs.some(message => message.includes('::warning::') && message.includes('usatechidxusd') &&
      message.includes('d1') && message.includes('2000-04-03') && /omitt|drop|skip|discard/i.test(message)),
    'warning identifies omitted data by instrument, period and datetime');
    assert.match(client.asset(first.releaseId, 'index.txt').bytes.toString(),
      /usatechidxusd\td1\tAmerica 🌎\t2000-12-29T00:00:00.000Z\t2000-12-29T00:00:00.000Z\t1\tok/);

    const tasks = [];
    const updated = await snapshot(client, join(directory, 'weekly'), {
      catalog: sourceCatalog, cutoff: '2001-01-08T00:00:00.000Z',
      poolFactory: poolProvider({ rows: [...sourceRows, bar('2001-01-02T00:00:00.000Z', 2800)], tasks }),
    });
    assert.equal(updated.status, 'published');
    const refreshed = await readInstrument(client, updated.releaseId, 'usatechidxusd', 'd1', join(directory, 'weekly-read'));
    assert.equal(refreshed.summary.rows, 2);
    for (const line of sourceLines) assert.ok(!refreshed.text.split('\n').includes(line), 'omitted bad bars must remain absent after an update');
    const refreshedLines = refreshed.text.trimEnd().split('\n');
    assert.ok(refreshedLines.every(line => line.length > 0));
    assert.deepEqual(refreshedLines.slice(1).map(line => line.split(',')[0]),
      ['2000-12-29T00:00:00.000Z', '2001-01-02T00:00:00.000Z'], 'updates append valid rows without rewriting or inventing timestamps');
    assert.match(client.asset(updated.releaseId, 'index.txt').bytes.toString(),
      /usatechidxusd\td1\tAmerica 🌎\t2000-12-29T00:00:00.000Z\t2001-01-02T00:00:00.000Z\t2\tok/);
    assert.ok(tasks.every(task => Date.parse(task.from) >= Date.parse('2000-12-29T00:00:00.000Z')),
      'weekly refresh resumes from the latest bar instead of redownloading anomalous old rows');
    assert.equal(client.releases.length, 1);
    assert.equal(client.releases[0].id, updated.releaseId);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('instrument download or processing failures checkpoint other work and retry only the failed cursor next run', async t => {
  for (const scenario of ['reported provider error', 'rejected download', 'invalid bar timestamp']) {
    await t.test(scenario, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'financial-isolated-failure-'));
      try {
        const client = new FakeGitHub();
        const multiCategoryCatalog = [
          { instrument: 'usatechidxusd', category: 'America 🌎', categorySlug: 'america', starts: { h1: start, d1: start } },
          { instrument: 'usa500idxusd', category: 'America 🌎', categorySlug: 'america', starts: { h1: start, d1: start } },
          catalog[0],
        ];
        const initialRows = [bar(start), bar('2026-01-02T00:00:00.000Z')];
        const previous = await snapshot(client, join(directory, 'previous'), {
          catalog: multiCategoryCatalog, poolFactory: poolProvider({ rows: initialRows }),
        });
        const cutoff = '2026-03-02T00:00:00.000Z';
        const updatedRows = [...initialRows, bar('2026-01-03T00:00:00.000Z'),
          bar('2026-02-01T00:00:00.000Z'), bar('2026-03-01T00:00:00.000Z')];
        const tasks = [];
        const logs = [];
        const eventOffset = client.events.length;
        const attempt = await snapshot(client, join(directory, 'partially-failed'), {
          catalog: multiCategoryCatalog, cutoff, log: message => logs.push(message),
          poolFactory: poolProvider({ rows: updatedRows, tasks, onTask(task) {
            if (task.instrument !== 'usatechidxusd' || task.period !== 'd1') return;
            if (scenario === 'reported provider error') return { error: new Error('Provider unavailable') };
            if (scenario === 'rejected download') throw new Error('Download promise rejected');
            return { bars: [{ ...bar('2026-01-03T00:00:00.000Z'), timestamp: 'invalid timestamp' }] };
          } }),
        });
        assert.equal(attempt.status, 'checkpointed');
        assert.match(attempt.reason, /retry/i);
        const failedTasks = tasks.filter(task => task.instrument === 'usatechidxusd' && task.period === 'd1');
        assert.equal(failedTasks.length, 1, 'a failing cursor is not retried repeatedly in the same attempt');
        assert.equal(failedTasks[0].from, '2026-01-02T00:00:00.000Z');
        const checkpoint = client.checkpoint(attempt.releaseId);
        const hourlyAndLaterGroups = checkpoint.groups.filter(group => group.id !== 'america-d1');
        assert.ok(hourlyAndLaterGroups.every(group => group.pairs.every(pair => pair.hasZip && pair.cursor === cutoff)),
          'later periods and categories must finish after the earlier D1 failure');
        const daily = checkpoint.groups.find(group => group.id === 'america-d1');
        const failedPair = daily.pairs.find(pair => pair.instrument === 'usatechidxusd');
        assert.equal(failedPair.cursor, failedTasks[0].from, 'failure must leave the retry cursor unchanged');
        assert.equal(failedPair.summary.rows, initialRows.length, 'existing data survives a failed update');
        const peer = daily.pairs.find(pair => pair.instrument === 'usa500idxusd');
        assert.equal(peer.cursor, cutoff);
        assert.equal(peer.summary.rows, updatedRows.length);
        assert.ok(logs.some(message => message.includes('::warning::') && message.includes('usatechidxusd') &&
          message.includes('d1') && message.includes('2026-01-02') && /retry/i.test(message)),
        'failed chunks are logged with sufficient context for retry');
        assert.ok(client.releases.some(release => release.id === previous.releaseId && !release.draft));
        assert.ok(!client.events.slice(eventOffset).some(event => ['publish', 'deleteRelease'].includes(event.type)),
          'an incomplete replacement must not publish or remove its predecessor');

        const resumeTasks = [];
        const resumed = await snapshot(client, join(directory, 'resumed'), {
          catalog: multiCategoryCatalog, cutoff,
          poolFactory: poolProvider({ rows: updatedRows, tasks: resumeTasks }),
        });
        assert.equal(resumed.status, 'published');
        assert.equal(resumed.releaseId, attempt.releaseId);
        assert.equal(resumeTasks.length, 1, 'completed instruments and categories are not downloaded again');
        assert.equal(resumeTasks[0].instrument, 'usatechidxusd');
        assert.equal(resumeTasks[0].period, 'd1');
        assert.equal(resumeTasks[0].from, failedTasks[0].from);
        const restored = await readInstrument(client, resumed.releaseId, 'usatechidxusd', 'd1', join(directory, 'read'));
        assert.equal(restored.summary.rows, updatedRows.length);
        assert.equal(client.releases.length, 1);
        assert.equal(client.releases[0].id, resumed.releaseId);
      } finally { await rm(directory, { recursive: true, force: true }); }
    });
  }
});

test('an interrupted backfill checkpoints real partial files and resumes the next month without repeating completed groups', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'financial-snapshot-'));
  try {
    const client = new FakeGitHub();
    const stop = { requested: false };
    const rows = [bar(start), bar('2026-02-01T00:00:00Z'), bar('2026-03-01T00:00:00Z')];
    const cutoff = '2026-03-02T00:00:00.000Z';
    const interrupted = await snapshot(client, join(directory, 'interrupted'), {
      cutoff, stop,
      poolFactory: poolProvider({ rows, onTask(task) { if (task.period === 'h1') stop.requested = true; } }),
    });
    assert.equal(interrupted.status, 'checkpointed');
    assert.equal(client.releases.length, 1);
    assert.equal(client.releases[0].draft, true);
    const checkpoint = client.checkpoint(interrupted.releaseId);
    const hourly = checkpoint.groups.find(group => group.period === 'h1');
    assert.ok(hourly.pairs.every(pair => pair.cursor === '2026-02-01T00:00:00.000Z'));
    assert.ok(hourly.pairs.every(pair => pair.hasZip && pair.summary.rows === 1));
    assert.equal(client.asset(interrupted.releaseId, 'index.txt'), undefined);
    const tasks = [];
    const resumed = await snapshot(client, join(directory, 'resumed'), {
      cutoff, poolFactory: poolProvider({ rows, tasks }),
    });
    assert.equal(resumed.status, 'published');
    assert.equal(resumed.releaseId, interrupted.releaseId);
    assert.ok(tasks.length > 0);
    assert.ok(tasks.every(task => task.period === 'h1' && Date.parse(task.from) >= Date.parse('2026-02-01T00:00:00Z')));
    const stored = await readInstrument(client, resumed.releaseId, 'gbpusd', 'h1', join(directory, 'resumed-read'));
    assert.equal(stored.summary.rows, 3);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('checkpoint upload failure retains predecessor and prior checkpoint; retry prunes orphans and publishes safely', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'financial-snapshot-'));
  try {
    const client = new FakeGitHub();
    const rows = [bar(start), bar('2026-01-02T00:00:00Z')];
    const first = await snapshot(client, join(directory, 'first'), { poolFactory: poolProvider({ rows }) });
    client.failUpload = ({ name }) => name === 'checkpoint-00000002.json';
    await assert.rejects(snapshot(client, join(directory, 'failed'), {
      cutoff: '2026-01-04T00:00:00.000Z',
      poolFactory: poolProvider({ rows: [...rows, bar('2026-01-03T00:00:00Z')] }),
    }), /Simulated upload failure/);
    assert.ok(client.releases.some(release => release.id === first.releaseId && !release.draft));
    const draft = client.releases.find(release => release.draft);
    assert.ok(draft);
    assert.equal(client.checkpoint(draft.id).sequence, 1);
    const orphan = client.assets.get(draft.id).find(asset => asset.name.endsWith('.tar'));
    assert.ok(orphan, 'uploaded group is orphaned when the new checkpoint cannot commit');
    assert.ok(!client.events.some(event => event.type === 'deleteRelease' && event.id === first.releaseId));
    client.failUpload = null;
    const resumed = await snapshot(client, join(directory, 'resumed'), {
      cutoff: '2026-01-04T00:00:00.000Z',
      poolFactory: poolProvider({ rows: [...rows, bar('2026-01-03T00:00:00Z')] }),
    });
    assert.equal(resumed.status, 'published');
    assert.equal(resumed.releaseId, draft.id);
    assert.ok(client.events.some(event => event.type === 'deleteAsset' && event.id === orphan.id));
    assert.equal(client.releases.length, 1);
    assert.equal(client.releases[0].id, draft.id);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an abandoned managed draft with no manifest loses only its orphan assets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'financial-snapshot-'));
  try {
    const client = new FakeGitHub();
    const draft = await client.createDraft({ tag: `${TAG_PREFIX}abandoned`, body: MARKER });
    const orphan = join(directory, 'orphan.tar');
    await writeFile(orphan, 'abandoned upload');
    const asset = await client.uploadAsset(draft, orphan, 'orphan.tar');
    const unrelated = await client.createDraft({ tag: 'application-release', body: 'Unrelated release' });
    await client.publish(unrelated.id);
    const result = await snapshot(client, join(directory, 'run'), {
      poolFactory: poolProvider({ rows: [bar(start)] }),
    });
    assert.equal(result.status, 'published');
    assert.equal(result.releaseId, draft.id);
    assert.ok(client.events.some(event => event.type === 'deleteAsset' && event.id === asset.id));
    assert.ok(client.releases.some(release => release.id === unrelated.id), 'unmanaged releases are retained');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a zero-byte starter checkpoint is ignored during recovery and removed as an orphan', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'financial-snapshot-'));
  try {
    const client = new FakeGitHub();
    const stop = { requested: false };
    const cutoff = '2026-03-02T00:00:00.000Z';
    const rows = [bar(start), bar('2026-02-01T00:00:00Z'), bar('2026-03-01T00:00:00Z')];
    const interrupted = await snapshot(client, join(directory, 'interrupted'), {
      cutoff, stop,
      poolFactory: poolProvider({ rows, onTask(task) { if (task.period === 'h1') stop.requested = true; } }),
    });
    const previous = client.checkpoint(interrupted.releaseId);
    const starter = { id: client.nextId++, name: `checkpoint-${String(previous.sequence + 1).padStart(8, '0')}.json`,
      state: 'starter', size: 0, bytes: Buffer.alloc(0) };
    client.assets.get(interrupted.releaseId).push(starter);
    const resumed = await snapshot(client, join(directory, 'resumed'), {
      cutoff, poolFactory: poolProvider({ rows }),
    });
    assert.equal(resumed.status, 'published');
    assert.ok(!client.events.some(event => event.type === 'download' && event.id === starter.id));
    assert.ok(client.events.some(event => event.type === 'deleteAsset' && event.id === starter.id));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('finalization interruption after metadata upload resumes with a later cutoff', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'financial-snapshot-'));
  try {
    const client = new FakeGitHub();
    const rows = [bar(start), bar('2026-01-02T00:00:00Z')];
    client.failPublish = true;
    await assert.rejects(snapshot(client, join(directory, 'interrupted'), {
      poolFactory: poolProvider({ rows }),
    }), /interruption before publication/);
    const draft = client.releases.find(release => release.draft);
    assert.ok(client.asset(draft.id, 'manifest.json'));
    assert.ok(client.asset(draft.id, 'index.txt'));
    assert.ok(!client.assets.get(draft.id).some(asset => asset.name.startsWith('checkpoint-')));
    client.failPublish = false;
    const updatedRows = [...rows, bar('2026-01-03T00:00:00Z')];
    const result = await snapshot(client, join(directory, 'resumed'), {
      cutoff: '2026-01-04T00:00:00.000Z', poolFactory: poolProvider({ rows: updatedRows }),
    });
    assert.equal(result.status, 'published');
    assert.equal(result.releaseId, draft.id);
    assert.equal(client.manifest(result.releaseId).cutoff, '2026-01-04T00:00:00.000Z');
    const stored = await readInstrument(client, result.releaseId, 'eurusd', 'h1', join(directory, 'read'));
    assert.equal(stored.summary.rows, 3);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('recovery from a finalization interruption retains durable state if the following update also fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'financial-snapshot-'));
  try {
    const client = new FakeGitHub();
    const rows = [bar(start), bar('2026-01-02T00:00:00Z')];
    client.failPublish = true;
    await assert.rejects(snapshot(client, join(directory, 'interrupted'), {
      poolFactory: poolProvider({ rows }),
    }), /interruption before publication/);
    const draft = client.releases[0];
    client.failPublish = false;
    client.failUpload = ({ name }) => name.endsWith('.tar');
    await assert.rejects(snapshot(client, join(directory, 'failed-again'), {
      cutoff: '2026-01-04T00:00:00.000Z',
      poolFactory: poolProvider({ rows: [...rows, bar('2026-01-03T00:00:00Z')] }),
    }), /Simulated upload failure/);
    assert.ok(client.assets.get(draft.id).some(asset => asset.state === 'uploaded' &&
      (asset.name === 'manifest.json' || /^checkpoint-\d{8}\.json$/.test(asset.name))),
    'a committed recovery manifest must remain until its replacement checkpoint uploads');
    client.failUpload = null;
    const resumed = await snapshot(client, join(directory, 'resumed'), {
      cutoff: '2026-01-04T00:00:00.000Z',
      poolFactory: poolProvider({ rows: [...rows, bar('2026-01-03T00:00:00Z')] }),
    });
    assert.equal(resumed.status, 'published');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an exhausted zero download budget checkpoints without starting downloads or publishing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'financial-snapshot-'));
  try {
    const client = new FakeGitHub();
    const result = await snapshot(client, directory, { budgetMs: 0,
      poolFactory() { assert.fail('the provider must not start after the download budget expires'); },
    });
    assert.equal(result.status, 'checkpointed');
    assert.equal(result.chunks, 0);
    assert.ok(client.checkpoint(result.releaseId));
    assert.equal(client.releases[0].draft, true);
    assert.ok(!client.events.some(event => event.type === 'publish'));
    assert.equal(client.asset(result.releaseId, 'index.txt'), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('default download concurrency reaches fifty and never exceeds it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'financial-snapshot-'));
  try {
    const client = new FakeGitHub();
    const largeCatalog = Array.from({ length: 60 }, (_, index) => ({
      instrument: `asset${String(index).padStart(3, '0')}`, category: 'Test category', categorySlug: 'test',
      starts: { h1: start, d1: start },
    }));
    let active = 0;
    let peak = 0;
    let downloads = 0;
    const result = await runSnapshot({ client, catalog: largeCatalog, workDirectory: directory,
      cutoff: '2026-01-02T00:00:00.000Z', budgetMs: 60_000, log: () => {},
      poolFactory: () => ({
        async download() {
          active += 1;
          downloads += 1;
          peak = Math.max(peak, active);
          await new Promise(resolve => setImmediate(resolve));
          active -= 1;
          return { bars: [] };
        },
        async stop() {},
      }),
    });
    assert.equal(result.status, 'published');
    assert.equal(peak, 50);
    assert.equal(downloads, largeCatalog.length * 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an interrupted public-name finalization resumes without redownloading or replacing archive IDs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'financial-snapshot-'));
  try {
    const client = new FakeGitHub();
    const rows = [bar(start), bar('2026-01-02T00:00:00Z')];
    let renames = 0;
    client.failRename = () => ++renames === 2;
    await assert.rejects(snapshot(client, join(directory, 'interrupted'), {
      poolFactory: poolProvider({ rows }),
    }), /Simulated rename interruption/);
    const draft = client.releases.find(release => release.draft);
    const archives = client.assets.get(draft.id).filter(asset => asset.name.endsWith('.tar'));
    assert.equal(archives.length, 2);
    assert.equal(archives.filter(asset => !/-v\d+-part/.test(asset.name)).length, 1);
    const originalIds = archives.map(asset => asset.id).sort((a, b) => a - b);
    const originalDigests = new Map(archives.map(asset => [asset.id, asset.digest]));
    client.failRename = null;
    const eventOffset = client.events.length;
    const resumed = await snapshot(client, join(directory, 'resumed'), {
      poolFactory() { assert.fail('a completed same-cutoff snapshot must not redownload provider data'); },
    });
    assert.equal(resumed.status, 'published');
    const finalized = client.assets.get(draft.id).filter(asset => asset.name.endsWith('.tar'));
    assert.deepEqual(finalized.map(asset => asset.id).sort((a, b) => a - b), originalIds);
    assert.ok(finalized.every(asset => asset.digest === originalDigests.get(asset.id)));
    assert.ok(finalized.every(asset => !/-v\d+-part/.test(asset.name)));
    assert.ok(!client.events.slice(eventOffset).some(event => event.type === 'upload' && event.name.endsWith('.tar')));
    assert.equal((await readInstrument(client, draft.id, 'eurusd', 'h1', join(directory, 'read'))).summary.rows, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('scheduled handoff drains current chunks, commits their bars, and lets the next attempt resume', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'financial-snapshot-'));
  try {
    const client = new FakeGitHub();
    const initialRows = [bar(start), bar('2026-01-02T00:00:00Z')];
    const first = await snapshot(client, join(directory, 'first'), {
      poolFactory: poolProvider({ rows: initialRows }),
    });
    const cutoff = '2026-03-02T00:00:00.000Z';
    const rows = [bar(start), bar('2026-01-02T00:00:00Z', 2), bar('2026-01-03T00:00:00Z'),
      bar('2026-02-01T00:00:00Z'), bar('2026-03-01T00:00:00Z')];
    let requestHandoff;
    let monitorClosed = false;
    let requested = false;
    let poolStopped = false;
    const tasks = [];
    const handoffMonitor = {
      async start(onRequest) { requestHandoff = onRequest; },
      async close() { monitorClosed = true; },
    };
    const eventOffset = client.events.length;
    const handoff = await snapshot(client, join(directory, 'handoff'), {
      cutoff, handoffMonitor,
      poolFactory: () => ({
        async download(task) {
          tasks.push(structuredClone(task));
          await new Promise(resolve => setImmediate(resolve));
          if (task.period === 'h1' && !requested) {
            requested = true;
            requestHandoff({ id: 99 });
          }
          await new Promise(resolve => setImmediate(resolve));
          assert.equal(poolStopped, false, 'a cooperative request must let current downloads finish');
          return { bars: rows.filter(item => item.timestamp >= Date.parse(task.from) && item.timestamp < Date.parse(task.to)) };
        },
        async stop() { poolStopped = true; },
      }),
    });
    assert.equal(requested, true);
    assert.equal(monitorClosed, true);
    assert.equal(handoff.status, 'checkpointed');
    assert.equal(handoff.reason, 'scheduled handoff');
    assert.equal(tasks.filter(task => task.period === 'h1').length, catalog.length, 'handoff schedules no further H1 chunks');
    assert.ok(client.releases.some(release => release.id === first.releaseId && !release.draft));
    assert.ok(!client.events.slice(eventOffset).some(event => ['publish', 'deleteRelease'].includes(event.type)));
    const checkpoint = client.checkpoint(handoff.releaseId);
    const hourly = checkpoint.groups.find(group => group.period === 'h1');
    assert.ok(hourly.pairs.every(pair => pair.cursor === '2026-02-01T00:00:00.000Z'));
    assert.ok(hourly.pairs.every(pair => pair.summary.rows === 3 && pair.hasZip));
    const resumeTasks = [];
    const resumed = await snapshot(client, join(directory, 'resumed'), {
      cutoff, poolFactory: poolProvider({ rows, tasks: resumeTasks }),
    });
    assert.equal(resumed.status, 'published');
    assert.equal(resumed.releaseId, handoff.releaseId);
    assert.ok(resumeTasks.every(task => task.period === 'h1' && task.from >= '2026-02-01T00:00:00.000Z'));
    assert.equal((await readInstrument(client, resumed.releaseId, 'eurusd', 'h1', join(directory, 'read'))).summary.rows, 5);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a handoff requested after all categories finish allows complete publication', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'financial-snapshot-'));
  try {
    const client = new FakeGitHub();
    let requestHandoff;
    let requested = false;
    let closed = false;
    const upload = client.uploadAsset.bind(client);
    client.uploadAsset = async (release, path, name) => {
      const result = await upload(release, path, name);
      if (name === 'index.txt') {
        requested = true;
        requestHandoff({ id: 99 });
      }
      return result;
    };
    const result = await snapshot(client, directory, {
      handoffMonitor: {
        async start(onRequest) { requestHandoff = onRequest; },
        async close() { closed = true; },
      },
      poolFactory: poolProvider({ rows: [bar(start)] }),
    });
    assert.equal(requested, true);
    assert.equal(closed, true);
    assert.equal(result.status, 'published');
    assert.equal(client.releases[0].draft, false);
    assert.equal(client.manifest(result.releaseId).complete, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
