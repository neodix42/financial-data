import { createHash } from 'node:crypto';

export const PACKAGE_VERSION = '1.51.1';
export const MARKER = 'financial-data snapshot v1';
export const TAG_PREFIX = 'financial-data-';
export const PERIODS = ['h1', 'd1'];

export function fingerprint(catalog) {
  return createHash('sha256').update(JSON.stringify(catalog)).digest('hex');
}

export function createState(catalog, cutoff, predecessor = null) {
  const groups = new Map();
  for (const item of catalog) {
    for (const period of PERIODS) {
      const id = `${item.categorySlug}-${period}`;
      if (!groups.has(id)) groups.set(id, {
        id, category: item.category, period, assets: [], pairs: [],
      });
      const previousGroup = predecessor?.groups.find(group => group.id === id);
      const previous = previousGroup?.pairs.find(pair => pair.instrument === item.instrument);
      groups.get(id).assets = previousGroup?.assets ?? [];
      groups.get(id).pairs.push(previous ? {
        ...structuredClone(previous),
        retired: false,
        // Include the latest saved candle so updates replace it instead of duplicating it.
        cursor: previous.summary?.last ?? predecessor.cutoff,
      } : {
        instrument: item.instrument, start: item.starts[period], cursor: item.starts[period],
        summary: null, hasZip: false, zipSha256: null,
      });
    }
  }
  // Never discard archived history merely because a package stops listing an instrument.
  for (const oldGroup of predecessor?.groups ?? []) {
    let group = groups.get(oldGroup.id);
    if (!group) {
      group = { ...structuredClone(oldGroup), pairs: [] };
      groups.set(group.id, group);
    }
    for (const old of oldGroup.pairs) {
      if (!group.pairs.some(pair => pair.instrument === old.instrument)) {
        group.pairs.push({ ...structuredClone(old), retired: true, cursor: cutoff });
      }
    }
  }
  return {
    schemaVersion: 1, marker: MARKER, packageVersion: PACKAGE_VERSION,
    catalogFingerprint: fingerprint(catalog), cutoff, createdAt: new Date().toISOString(),
    priceType: 'bid', closedBarsOnly: true, ignoreFlats: false, volumeUnits: 'millions',
    previousReleaseId: predecessor?.releaseId ?? null,
    previousTag: predecessor?.tag ?? null,
    sequence: 0, complete: false,
    groups: [...groups.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function validateState(state, catalog) {
  if (state.schemaVersion !== 1 || state.marker !== MARKER ||
      state.packageVersion !== PACKAGE_VERSION || state.priceType !== 'bid' ||
      state.closedBarsOnly !== true || state.ignoreFlats !== false ||
      state.catalogFingerprint !== fingerprint(catalog) || !Number.isFinite(Date.parse(state.cutoff))) {
    throw new Error('Checkpoint configuration differs from this downloader; refusing to mix datasets.');
  }
  const seen = new Set();
  for (const group of state.groups) {
    if (!/^[a-z0-9-]+$/.test(group.id) || !PERIODS.includes(group.period)) throw new Error('Invalid checkpoint group');
    for (const pair of group.pairs) {
      const key = `${pair.instrument}-${group.period}`;
      if (!/^[a-z0-9]+$/.test(pair.instrument) || seen.has(key) ||
          !Number.isFinite(Date.parse(pair.cursor)) || !Number.isFinite(Date.parse(pair.start))) {
        throw new Error(`Invalid checkpoint pair: ${key}`);
      }
      seen.add(key);
    }
  }
  for (const item of catalog) for (const period of PERIODS) {
    if (!seen.has(`${item.instrument}-${period}`)) throw new Error(`Checkpoint missing ${item.instrument}-${period}`);
  }
}

export function resumeState(state, cutoff, catalog) {
  validateState(state, catalog);
  if (Date.parse(cutoff) < Date.parse(state.cutoff)) throw new Error('Execution cutoff precedes checkpoint cutoff');
  if (cutoff === state.cutoff) return state;
  const oldCutoff = state.cutoff;
  for (const group of state.groups) for (const pair of group.pairs) {
    if (pair.retired) pair.cursor = cutoff;
    else if (Date.parse(pair.cursor) >= Date.parse(oldCutoff)) {
      pair.cursor = pair.summary?.last ?? oldCutoff;
    }
  }
  state.cutoff = cutoff;
  state.complete = false;
  return state;
}

export function nextChunk(pair, period, cutoff) {
  const from = Date.parse(pair.cursor);
  if (pair.retired || from >= Date.parse(cutoff)) return null;
  const date = new Date(from);
  const boundary = period === 'h1'
    ? Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
    : Date.UTC(date.getUTCFullYear() + 1, 0, 1);
  return { instrument: pair.instrument, period, from: pair.cursor,
    to: new Date(Math.min(boundary, Date.parse(cutoff))).toISOString() };
}

export function isComplete(state) {
  return state.groups.every(group => group.pairs.every(pair =>
    pair.hasZip && (pair.retired || Date.parse(pair.cursor) >= Date.parse(state.cutoff))));
}

export function makeIndex(state) {
  const lines = [
    `# ${MARKER}; cutoff=${state.cutoff}; price=bid; timezone=UTC; closed_bars_only=true; volume_units=millions`,
    'instrument\tperiod\tcategory\tfirst_bar_utc\tlast_bar_utc\trows\tstatus\tarchive\tzip',
  ];
  for (const group of state.groups) for (const pair of group.pairs) {
    const complete = pair.retired || Date.parse(pair.cursor) >= Date.parse(state.cutoff);
    const status = !complete ? 'pending' : pair.retired ? 'retired' : pair.summary?.rows ? 'ok' : 'no_data';
    lines.push([pair.instrument, group.period, group.category,
      pair.summary?.first ?? '-', pair.summary?.last ?? '-', pair.summary?.rows ?? 0,
      status, pair.bundle ?? '-', `${pair.instrument}-${group.period}.zip`].join('\t'));
  }
  return `${lines.join('\n')}\n`;
}
