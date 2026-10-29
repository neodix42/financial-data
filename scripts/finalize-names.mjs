function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Give a completed draft clean public names without replacing its asset bytes.
 * Checkpoint manifests identify assets by ID, so a crash partway through these
 * renames leaves their data recoverable from the preceding committed manifest.
 */
export async function stabilizeArchiveNames(client, release, state) {
  if (release.draft !== true) throw new Error('Archive names may only be finalized on a draft release');
  const plan = [];
  const targetNames = new Set();
  const assetIds = new Set();
  const replacements = new Map();

  // Validate the entire plan before the first mutation. A bad reference must not
  // rename some valid assets and then fail on an unrelated group.
  for (const group of state.groups) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(group.id)) throw new Error('Invalid archive group');
    const pattern = new RegExp(`^${escapeRegExp(group.id)}(?:-v\\d+)?-(part\\d{3,}\\.tar)$`);
    for (const asset of group.assets) {
      if (asset.releaseId !== release.id) throw new Error(`Archive belongs to a different release: ${asset.name}`);
      const match = pattern.exec(asset.name);
      if (!match || /^part0+\.tar$/.test(match[1])) throw new Error(`Invalid category archive name: ${asset.name}`);
      const name = `${group.id}-${match[1]}`;
      if (targetNames.has(name) || assetIds.has(asset.id)) throw new Error(`Duplicate archive finalization target: ${name}`);
      targetNames.add(name);
      assetIds.add(asset.id);
      replacements.set(asset.name, name);
      plan.push({ asset, name });
    }
    for (const pair of group.pairs) {
      if (pair.bundle !== undefined && !group.assets.some(asset => asset.name === pair.bundle)) {
        throw new Error(`Instrument references an unknown archive: ${pair.instrument}`);
      }
    }
  }

  for (const { asset, name } of plan) {
    // PATCH is intentional even when the manifest already has the stable name:
    // after a crash, its name and the server's name need not have changed together.
    const actual = await client.renameAsset(asset.id, name);
    if (actual.id !== asset.id || actual.name !== name || actual.state !== 'uploaded' ||
        actual.size !== asset.size ||
        (actual.digest && actual.digest !== `sha256:${asset.sha256}`)) {
      throw new Error(`Archive changed while finalizing its name: ${asset.name}`);
    }
  }

  // Update manifest/index references only after every rename has been confirmed.
  for (const { asset, name } of plan) asset.name = name;
  for (const group of state.groups) for (const pair of group.pairs) {
    if (pair.bundle !== undefined) pair.bundle = replacements.get(pair.bundle);
  }
  return state;
}
