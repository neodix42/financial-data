import { instrumentMetaData } from 'dukascopy-node';
import { mkdir, readFile, writeFile, rm, access, statfs } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { buildCatalog } from './catalog.mjs';
import { GitHubReleases } from './github.mjs';
import { DownloadPool } from './pool.mjs';
import { ScheduledHandoff } from './handoff.mjs';
import { stabilizeArchiveNames } from './finalize-names.mjs';
import { inspectCsv, mergeBars, zipCsv, unzipCsv, packFiles, extractTar, sha256 } from './storage.mjs';
import { createState, validateState, resumeState, nextChunk, isComplete, makeIndex, MARKER, TAG_PREFIX } from './state.mjs';

const exists = path => access(path).then(() => true, () => false);
const isManaged = release => release.tag_name.startsWith(TAG_PREFIX) && release.body?.includes(MARKER);
const checkpointNumber = name => Number(/^checkpoint-(\d{8})\.json$/.exec(name)?.[1] ?? 0);
const pad = value => String(value).padStart(8, '0');

async function readManifest(client, release, directory) {
  // Failed GitHub uploads can leave zero-byte "starter" assets: they are not commits.
  const assets = (await client.listAssets(release.id)).filter(asset => asset.state === 'uploaded');
  const candidate = release.draft
    ? assets.filter(asset => checkpointNumber(asset.name)).sort((a, b) => checkpointNumber(b.name) - checkpointNumber(a.name))[0]
      ?? assets.find(asset => asset.name === 'manifest.json')
    : assets.find(asset => asset.name === 'manifest.json');
  if (!candidate) return null;
  const path = join(directory, `manifest-${release.id}.json`);
  await client.downloadAsset(candidate, path);
  const state = JSON.parse(await readFile(path, 'utf8'));
  if (state.releaseId !== release.id || state.marker !== MARKER ||
      (!release.draft && !state.complete)) throw new Error(`Invalid managed release manifest: ${release.tag_name}`);
  return state;
}

async function cleanOldReleases(client, releases, current, log) {
  for (const release of releases.filter(item => isManaged(item) && !item.draft && item.id !== current.id)) {
    // Cleanup runs only after the complete replacement has been verified as published.
    try {
      await client.deleteRelease(release.id);
      log(`Deleted preceding snapshot ${release.tag_name}`);
    } catch (error) {
      log(`::warning::Could not delete ${release.tag_name}: ${error.message}; cleanup will retry next run.`);
    }
  }
}

async function pruneDraft(client, release, state, log) {
  const keep = new Set(state.groups.flatMap(group => group.assets)
    .filter(asset => asset.releaseId === release.id).map(asset => asset.id));
  const checkpoint = `checkpoint-${pad(state.sequence)}.json`;
  const assets = await client.listAssets(release.id);
  const hasCheckpoint = assets.some(asset => asset.name === checkpoint && asset.state === 'uploaded');
  for (const asset of assets) {
    if (keep.has(asset.id) || asset.name === checkpoint) continue;
    // A crash immediately before publication leaves manifest.json as the only
    // durable checkpoint. Retain it until a replacement checkpoint commits.
    if (!hasCheckpoint && ['manifest.json', 'index.txt'].includes(asset.name)) continue;
    try { await client.deleteAsset(asset.id); }
    catch (error) { log(`::warning::Draft cleanup deferred for ${asset.name}: ${error.message}`); }
  }
}

async function commitCheckpoint(client, release, state, directory, log) {
  state.sequence += 1;
  const name = `checkpoint-${pad(state.sequence)}.json`;
  const path = join(directory, name);
  await writeFile(path, `${JSON.stringify(state)}\n`);
  await client.uploadAsset(release, path, name);
  // Commit last, then prune: failures before the manifest upload leave the old checkpoint intact.
  await pruneDraft(client, release, state, log);
}

async function restoreGroup(client, group, directory, workDirectory) {
  await mkdir(directory, { recursive: true });
  const allowedNames = group.pairs.filter(pair => pair.hasZip).map(pair => `${pair.instrument}-${group.period}.zip`);
  for (const asset of group.assets) {
    const path = join(workDirectory, `restore-${asset.id}.tar`);
    const downloaded = await client.downloadAsset(asset, path);
    if (downloaded.sha256 !== asset.sha256) throw new Error(`Category archive checksum mismatch: ${asset.name}`);
    await extractTar(path, directory, { allowedNames });
    await rm(path);
  }
  for (const pair of group.pairs.filter(item => item.hasZip)) {
    const path = join(directory, `${pair.instrument}-${group.period}.zip`);
    if (await sha256(path) !== pair.zipSha256) throw new Error(`Instrument ZIP checksum mismatch: ${pair.instrument}`);
  }
}

async function ensureCsv(pair, group, directory, cutoff) {
  const name = `${pair.instrument}-${group.period}.csv`;
  const path = join(directory, name);
  if (await exists(path)) return path;
  if (pair.hasZip) {
    await unzipCsv(join(directory, `${pair.instrument}-${group.period}.zip`), directory, name);
    const actual = await inspectCsv(path);
    if (JSON.stringify(actual) !== JSON.stringify(pair.summary)) throw new Error(`CSV summary mismatch for ${name}`);
  } else {
    pair.summary = await mergeBars(path, [], { from: pair.start, cutoff, period: group.period });
  }
  return path;
}

async function finishZip(pair, group, directory) {
  const csv = join(directory, `${pair.instrument}-${group.period}.csv`);
  if (!(await exists(csv))) return;
  const actual = await inspectCsv(csv);
  if (JSON.stringify(actual) !== JSON.stringify(pair.summary)) throw new Error(`CSV validation failed for ${pair.instrument}`);
  const zip = join(directory, `${pair.instrument}-${group.period}.zip`);
  await zipCsv(csv, zip);
  pair.zipSha256 = await sha256(zip);
  pair.hasZip = true;
  await rm(csv);
}

async function saveGroup(client, release, state, group, directory, workDirectory, log, maxArchiveBytes) {
  for (const pair of group.pairs) await finishZip(pair, group, directory);
  const files = group.pairs.filter(pair => pair.hasZip)
    .map(pair => join(directory, `${pair.instrument}-${group.period}.zip`));
  const output = join(workDirectory, 'packed');
  const bundles = await packFiles(files, output, `${group.id}-v${pad(state.sequence + 1)}`,
    maxArchiveBytes ? { maxBytes: maxArchiveBytes } : {});
  const currentAssets = await client.listAssets(release.id);
  if (currentAssets.length + bundles.length + 3 > 1000) {
    throw new Error('Category splitting would exceed the 1,000 release-asset limit; checkpoint remains available.');
  }
  const uploaded = [];
  for (const bundle of bundles) {
    const asset = await client.uploadAsset(release, bundle.path, bundle.name);
    if (!asset.digest) {
      const verification = join(workDirectory, 'verify-upload.tar');
      const download = await client.downloadAsset(asset, verification);
      if (download.sha256 !== bundle.sha256) throw new Error(`Uploaded archive checksum mismatch: ${bundle.name}`);
      await rm(verification);
    }
    uploaded.push({ id: asset.id, name: asset.name, size: asset.size,
      sha256: bundle.sha256, digest: asset.digest, releaseId: release.id });
    for (const member of bundle.members) {
      const instrument = member.slice(0, -`-${group.period}.zip`.length);
      group.pairs.find(pair => pair.instrument === instrument).bundle = bundle.name;
    }
    await rm(bundle.path);
  }
  group.assets = uploaded;
  await commitCheckpoint(client, release, state, workDirectory, log);
  log(`Checkpoint ${state.sequence}: ${group.category} ${group.period}; ` +
    `${group.pairs.filter(pair => Date.parse(pair.cursor) >= Date.parse(state.cutoff)).length}/${group.pairs.length} complete`);
}

async function validateUploads(client, release, state) {
  if (!isComplete(state)) throw new Error('Refusing to publish incomplete instrument coverage');
  const uploaded = new Map((await client.listAssets(release.id)).map(asset => [asset.id, asset]));
  for (const group of state.groups) for (const asset of group.assets) {
    const actual = uploaded.get(asset.id);
    if (asset.releaseId !== release.id || !actual || actual.name !== asset.name ||
        actual.state !== 'uploaded' || actual.size !== asset.size ||
        (actual.digest && actual.digest !== `sha256:${asset.sha256}`)) {
      throw new Error(`Missing or invalid uploaded category archive: ${asset.name}`);
    }
  }
}

/** Run one resumable attempt. A budget stop is a successful checkpoint, never a partial publication. */
export async function runSnapshot({
  client = new GitHubReleases(),
  catalog = buildCatalog(instrumentMetaData),
  workDirectory = resolve('.data', randomUUID()),
  cutoff = new Date().toISOString(),
  startedAt = Date.now(),
  budgetMs = 5 * 60 * 60_000,
  finalizationBudgetMs = 355 * 60_000,
  parallel = 50,
  checkpointMs = 20 * 60_000,
  maxArchiveBytes,
  poolFactory = options => new DownloadPool(options),
  log = console.log,
  stop = { requested: false },
  handoffMonitor = null,
} = {}) {
  if (!Number.isInteger(parallel) || parallel < 1 || parallel > 200) throw new Error('Parallel downloads must be between 1 and 200');
  if (!Number.isFinite(Date.parse(cutoff)) || budgetMs < 0 || checkpointMs <= 0) throw new Error('Invalid execution budget/cutoff');
  // Leave the final five minutes before GitHub's hard kill unused. Expired transfers
  // fail safely against the preceding committed checkpoint instead of hanging on retries.
  client.deadline = Math.min(client.deadline ?? Infinity, startedAt + finalizationBudgetMs);
  await mkdir(workDirectory, { recursive: true });
  const deadline = startedAt + budgetMs;
  const releases = (await client.listReleases()).filter(isManaged)
    .sort((a, b) => Date.parse(b.published_at || b.created_at) - Date.parse(a.published_at || a.created_at));
  const published = releases.find(release => !release.draft && !release.prerelease);
  const drafts = releases.filter(release => release.draft);
  if (drafts.length > 1) throw new Error('Multiple managed draft snapshots exist; refusing ambiguous recovery');
  let release = drafts[0];
  let state = release ? await readManifest(client, release, workDirectory) : null;
  if (state) {
    // Finish the saved snapshot before widening its target. Moving the cutoff on
    // every retry reopens completed histories and can prevent a backfill from
    // ever reaching publication; a new snapshot advances it after this publishes.
    resumeState(state, state.cutoff, catalog);
    log(`Resuming ${release.tag_name} from checkpoint ${state.sequence}; cutoff ${state.cutoff}`);
    // Keep the last committed checkpoint until the new one is durable.
    await pruneDraft(client, release, state, log);
  } else {
    const predecessor = published ? await readManifest(client, published, workDirectory) : null;
    if (published && !predecessor) throw new Error('Published snapshot has no manifest; refusing an accidental full re-download');
    if (predecessor) await cleanOldReleases(client, releases, published, log);
    state = createState(catalog, cutoff, predecessor);
    const tag = `${TAG_PREFIX}${cutoff.replace(/[-:.]/g, '')}-${randomUUID().slice(0, 8)}`;
    release ??= await client.createDraft({ tag, body: `${MARKER}\nCategory-grouped H1/D1 historical data.`, target: process.env.GITHUB_SHA });
    state.releaseId = release.id;
    state.tag = release.tag_name;
    // An empty abandoned draft may have orphan uploads, but no committed state to preserve.
    await commitCheckpoint(client, release, state, workDirectory, log);
  }
  validateState(state, catalog);
  let pool;
  let failure;
  const failedPairs = new Set();
  const recordFailure = (group, task, error) => {
    failedPairs.add(`${group.id}/${task.instrument}`);
    log(`::warning::${task.instrument} ${task.period} [${task.from}, ${task.to}): ${error.message}. ` +
      'Cursor retained for retry next run; continuing other instruments.');
  };
  let chunks = 0;
  const stopHandler = () => { stop.requested = true; void pool?.stop(); };
  process.once('SIGTERM', stopHandler);
  process.once('SIGINT', stopHandler);
  try {
    await handoffMonitor?.start(run => {
      stop.requested = true;
      stop.reason = 'scheduled handoff';
      log(`Scheduled run ${run.id} requested a handoff. Finishing active chunks and saving the draft checkpoint.`);
      // Do not kill the pool here: allow already-started date chunks to return
      // and merge their bars before the category is packaged and checkpointed.
    });
    for (const group of state.groups) {
      if (Date.now() >= deadline || stop.requested || failure) break;
      const owned = group.assets.length && group.assets.every(asset => asset.releaseId === release.id);
      if (owned && group.pairs.every(pair => pair.hasZip && !nextChunk(pair, group.period, state.cutoff))) continue;
      const directory = join(workDirectory, group.id);
      await restoreGroup(client, group, directory, workDirectory);
      let lastCheckpointAt = Date.now();
      let dirty = false;
      while (Date.now() < deadline && !stop.requested && !failure) {
        const jobs = group.pairs.filter(pair => !failedPairs.has(`${group.id}/${pair.instrument}`) &&
          nextChunk(pair, group.period, state.cutoff)).slice(0, parallel);
        if (!jobs.length) break;
        const free = await statfs(workDirectory);
        if (free.bavail * free.bsize < 512 * 1024 ** 2) {
          failure = new Error('Less than 512 MiB disk space remains; saving checkpoint before stopping');
          break;
        }
        if (stop.requested || Date.now() >= deadline) break;
        pool ??= poolFactory({ deadline });
        const tasks = jobs.map(pair => nextChunk(pair, group.period, state.cutoff));
        const results = await Promise.all(tasks.map(async task => {
          try { return await pool.download(task); }
          catch (error) { return { error }; }
        }));
        for (const [index, result] of results.entries()) {
          const pair = jobs[index];
          const task = tasks[index];
          if (result.error) {
            if (result.error.code === 'DUKASCOPY_INSTRUMENT_UNAVAILABLE' && result.error.availability) {
              try {
                // Keep any existing history. For never-available instruments,
                // write an honest header-only archive with explicit source status.
                await ensureCsv(pair, group, directory, state.cutoff);
                dirty = true;
                await finishZip(pair, group, directory);
                pair.unavailable = result.error.availability;
                pair.cursor = state.cutoff;
                log(`::warning::${task.instrument} ${task.period}: provider-unavailable; ` +
                  `${result.error.message}. Existing history retained and status recorded in index.txt.`);
              } catch (error) { recordFailure(group, task, error); }
            } else recordFailure(group, task, result.error);
            continue;
          }
          if (result.cancelled) {
            if (!stop.requested && Date.now() < deadline) recordFailure(group, task, new Error('Download cancelled before completion'));
            continue;
          }
          try {
            const csv = await ensureCsv(pair, group, directory, state.cutoff);
            pair.summary = await mergeBars(csv, result.bars, {
              from: task.from, cutoff: state.cutoff, period: group.period, summary: pair.summary,
              onWarning: message => log(`::warning::${message}`),
            });
            dirty = true;
            if (Date.parse(task.to) >= Date.parse(state.cutoff)) await finishZip(pair, group, directory);
            pair.cursor = task.to;
            chunks += 1;
          } catch (error) {
            recordFailure(group, task, error);
          }
        }
        // A worker timeout/crash settles its active tasks. Other instruments can
        // continue in a fresh worker; failed cursors stay pending until next run.
        if (pool?.stopped && !stop.requested && Date.now() < deadline) {
          await pool.stop();
          pool = null;
        }
        if (chunks && chunks % 250 < jobs.length) log(`Saved ${chunks} date chunks this attempt; current category ${group.id}`);
        if (Date.now() - lastCheckpointAt >= checkpointMs && dirty) {
          await saveGroup(client, release, state, group, directory, workDirectory, log, maxArchiveBytes);
          dirty = false;
          lastCheckpointAt = Date.now();
        }
      }
      // Instruments whose availability starts after the cutoff still need an explicit empty archive.
      for (const pair of group.pairs.filter(item => !item.hasZip && !nextChunk(item, group.period, state.cutoff))) {
        await ensureCsv(pair, group, directory, state.cutoff);
        dirty = true;
      }
      if (dirty || !owned) await saveGroup(client, release, state, group, directory, workDirectory, log, maxArchiveBytes);
      await rm(directory, { recursive: true, force: true });
    }
    await pool?.stop();
    if (failure) throw failure;
    if (!isComplete(state)) {
      const reason = stop.reason ?? (stop.requested ? 'stop requested' : failedPairs.size
        ? `${failedPairs.size} instrument/period chunk(s) failed; retry pending` : 'download budget reached');
      log(`${reason}. Draft checkpoint saved; the next scheduled/manual run will resume.`);
      return { status: 'checkpointed', releaseId: release.id, chunks, reason };
    }
    // Renaming by asset ID preserves checkpoint recoverability, including when
    // an earlier finalization attempt renamed only some of the archives.
    await stabilizeArchiveNames(client, release, state);
    await validateUploads(client, release, state);
    state.complete = true;
    await commitCheckpoint(client, release, state, workDirectory, log);
    await writeFile(join(workDirectory, 'index.txt'), makeIndex(state));
    await writeFile(join(workDirectory, 'manifest.json'), `${JSON.stringify(state, null, 2)}\n`);
    for (const name of ['index.txt', 'manifest.json']) {
      await client.uploadAsset(release, join(workDirectory, name), name);
    }
    // Final metadata is durable before removing recovery metadata from the draft.
    for (const asset of await client.listAssets(release.id)) {
      if (checkpointNumber(asset.name)) await client.deleteAsset(asset.id);
    }
    await validateUploads(client, release, state);
    const finished = await client.publish(release.id);
    const verified = await client.getRelease(release.id);
    if (finished.draft || verified.draft) throw new Error('New release was not published; preceding snapshot retained');
    const verifiedManifest = await readManifest(client, verified, workDirectory);
    if (!verifiedManifest?.complete) throw new Error('Published manifest missing; preceding snapshot retained');
    await cleanOldReleases(client, releases, verified, log);
    log(`Published ${release.tag_name}: ${state.groups.length} category/period groups, ${chunks} date chunks.`);
    return { status: 'published', releaseId: release.id, chunks };
  } finally {
    await handoffMonitor?.close();
    await pool?.stop();
    process.removeListener('SIGTERM', stopHandler);
    process.removeListener('SIGINT', stopHandler);
  }
}

async function main() {
  if (process.argv.includes('--catalog')) {
    const catalog = buildCatalog(instrumentMetaData);
    const counts = {};
    for (const item of catalog) counts[item.category] = (counts[item.category] ?? 0) + 1;
    console.log(JSON.stringify({ instruments: catalog.length, periods: ['h1', 'd1'], categories: counts }, null, 2));
    return;
  }
  const budgetMinutes = Number(process.env.DOWNLOAD_BUDGET_MINUTES || 300);
  if (!Number.isFinite(budgetMinutes) || budgetMinutes <= 0 || budgetMinutes > 300) throw new Error('Download budget must be between 0 and 300 minutes');
  const startedAt = Number(process.env.SNAPSHOT_STARTED_AT || Date.now());
  if (!Number.isFinite(startedAt)) throw new Error('Invalid SNAPSHOT_STARTED_AT');
  const client = new GitHubReleases();
  const handoffMonitor = process.env.GITHUB_RUN_ID ? new ScheduledHandoff({
    client, workflow: process.env.SNAPSHOT_WORKFLOW || 'historical-data.yml',
    runId: process.env.GITHUB_RUN_ID, runNumber: process.env.GITHUB_RUN_NUMBER,
  }) : null;
  const result = await runSnapshot({ client, handoffMonitor,
    parallel: Number(process.env.DOWNLOAD_THREADS || 50),
    startedAt, budgetMs: budgetMinutes * 60_000 });
  if (process.env.GITHUB_STEP_SUMMARY) {
    await writeFile(process.env.GITHUB_STEP_SUMMARY,
      `Snapshot **${result.status}**. Release ID: ${result.releaseId}. Downloaded chunks: ${result.chunks}.` +
      `${result.reason ? ` Reason: ${result.reason}.` : ''}\n`, { flag: 'a' });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.stack); process.exitCode = 1; });
}
