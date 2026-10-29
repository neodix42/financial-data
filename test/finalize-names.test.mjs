import test from 'node:test';
import assert from 'node:assert/strict';
import { stabilizeArchiveNames } from '../scripts/finalize-names.mjs';

function fixture() {
  const release = { id: 7, draft: true };
  const state = {
    groups: [{
      id: 'forex-major-currencies-h1',
      assets: [1, 2].map(id => ({
        id, releaseId: 7, name: `forex-major-currencies-h1-v00000024-part00${id}.tar`,
        size: 10240, sha256: String(id).repeat(64),
      })),
      pairs: [1, 2].map(id => ({
        instrument: id === 1 ? 'eurusd' : 'gbpusd', hasZip: true,
        bundle: `forex-major-currencies-h1-v00000024-part00${id}.tar`,
      })),
    }],
  };
  const stored = new Map(state.groups[0].assets.map(asset => [asset.id, {
    ...structuredClone(asset), state: 'uploaded', digest: `sha256:${asset.sha256}`,
  }]));
  const events = [];
  const client = {
    failId: null,
    async renameAsset(id, name) {
      events.push({ id, name });
      if (id === this.failId) throw new Error('Simulated interrupted rename');
      const asset = stored.get(id);
      asset.name = name;
      return structuredClone(asset);
    },
  };
  return { release, state, stored, events, client };
}

test('final archive names are stable while IDs, size, checksums and ZIP names remain unchanged', async () => {
  const { release, state, stored, events, client } = fixture();
  const before = structuredClone(state);
  assert.equal(await stabilizeArchiveNames(client, release, state), state);
  assert.deepEqual(events, [1, 2].map(id => ({ id, name: `forex-major-currencies-h1-part00${id}.tar` })));
  for (let index = 0; index < 2; index++) {
    const old = before.groups[0].assets[index];
    const asset = state.groups[0].assets[index];
    assert.equal(asset.name, `forex-major-currencies-h1-part00${index + 1}.tar`);
    assert.deepEqual({ ...asset, name: old.name }, old);
    assert.equal(stored.get(asset.id).digest, `sha256:${asset.sha256}`);
    assert.equal(state.groups[0].pairs[index].bundle, asset.name);
  }
});

test('partial rename failure leaves manifest unchanged and retries by the same asset IDs', async () => {
  const { release, state, stored, client } = fixture();
  const committed = structuredClone(state);
  client.failId = 2;
  await assert.rejects(stabilizeArchiveNames(client, release, state), /interrupted rename/);
  assert.deepEqual(state, committed, 'the preceding checkpoint stays valid until all renames finish');
  assert.equal(stored.get(1).name, 'forex-major-currencies-h1-part001.tar');
  assert.equal(stored.get(2).name, 'forex-major-currencies-h1-v00000024-part002.tar');
  client.failId = null;
  await stabilizeArchiveNames(client, release, state);
  assert.ok(state.groups[0].assets.every(asset => !asset.name.includes('-v00000024')));
  assert.deepEqual([...stored.keys()], [1, 2], 'resuming never deletes or reuploads archive bytes');
  const finalized = structuredClone(state);
  await stabilizeArchiveNames(client, release, state);
  assert.deepEqual(state, finalized, 'already finalized names are idempotent');
});

test('published releases and inherited assets are rejected before any renames', async () => {
  const { release, state, events, client } = fixture();
  await assert.rejects(stabilizeArchiveNames(client, { ...release, draft: false }, state), /draft release/);
  state.groups[0].assets[1].releaseId = 6;
  await assert.rejects(stabilizeArchiveNames(client, release, state), /different release/);
  assert.deepEqual(events, []);
});

test('invalid member references and duplicate public names fail before mutating storage', async () => {
  const { release, state, events, client } = fixture();
  state.groups[0].pairs[0].bundle = 'unknown.tar';
  await assert.rejects(stabilizeArchiveNames(client, release, state), /unknown archive/);
  state.groups[0].pairs[0].bundle = state.groups[0].assets[0].name;
  state.groups[0].assets[1].name = 'forex-major-currencies-h1-part001.tar';
  await assert.rejects(stabilizeArchiveNames(client, release, state), /Duplicate archive/);
  assert.deepEqual(events, []);
});

test('rename response must confirm unchanged identity, complete state, size and checksum', async () => {
  for (const response of [
    { id: 99 }, { state: 'starter' }, { size: 12 }, { digest: `sha256:${'f'.repeat(64)}` },
  ]) {
    const { release, state, client } = fixture();
    const before = structuredClone(state);
    const rename = client.renameAsset.bind(client);
    client.renameAsset = async (id, name) => ({ ...await rename(id, name), ...response });
    await assert.rejects(stabilizeArchiveNames(client, release, state), /changed while finalizing/);
    assert.deepEqual(state, before);
  }
});
