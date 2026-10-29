import { readFileSync } from 'node:fs';

const categoryData = JSON.parse(readFileSync(new URL('../data/categories.json', import.meta.url), 'utf8'));

/** Human-readable categories follow the upstream instrument list, including emoji. */
export const categories = categoryData.categories;
export const categorySource = categoryData.source;
export const catalogPackageVersion = categoryData.packageVersion;

const membership = new Map();
const slugs = new Set();
for (const category of categories) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(category.slug) || slugs.has(category.slug)) {
    throw new Error(`Invalid or duplicate category slug: ${category.slug}`);
  }
  slugs.add(category.slug);
  for (const instrument of category.instruments) {
    if (membership.has(instrument)) throw new Error(`Duplicate instrument category: ${instrument}`);
    membership.set(instrument, category);
  }
}
const ungrouped = categories.find(category => category.id === 'ungrouped');
const earliest = Date.parse('2000-01-01T00:00:00.000Z');

function historyStart(metadata, field, instrument) {
  const timestamp = Date.parse(metadata[field]);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Missing or invalid ${field} for ${instrument}`);
  }
  return new Date(Math.max(earliest, timestamp)).toISOString();
}

/** Build coverage from the installed provider package, never just the category list. */
export function buildCatalog(metadata) {
  return Object.keys(metadata).sort().map(instrument => {
    if (!/^[a-z0-9]+$/.test(instrument)) throw new Error(`Unsafe instrument ID: ${instrument}`);
    const category = membership.get(instrument) ?? ungrouped;
    return {
      instrument,
      category: category.name,
      categorySlug: category.slug,
      starts: {
        h1: historyStart(metadata[instrument], 'startMonthForHourlyCandles', instrument),
        d1: historyStart(metadata[instrument], 'startYearForDailyCandles', instrument),
      },
    };
  });
}
