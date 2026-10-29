import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const API = 'https://api.github.com';
const MAX_ASSET_BYTES = 2 * 1024 ** 3;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class GitHubError extends Error {
  constructor(message, { status, retryAfterMs, retryable = false } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.retryable = retryable;
  }
}

/** Release storage only: this client never writes dataset contents into Git. */
export class GitHubReleases {
  constructor({
    repository = process.env.GITHUB_REPOSITORY,
    token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
    fetchImpl = globalThis.fetch,
    sleep = delay,
    now = Date.now,
    retries = 4,
    minWriteIntervalMs = 8_000,
    requestTimeoutMs = 120_000,
    assetTimeoutMs = 20 * 60_000,
    maxRetryDelayMs = 15 * 60_000,
    deadline = Infinity,
  } = {}) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '')) throw new Error('GITHUB_REPOSITORY must be owner/repository');
    if (!token) throw new Error('GH_TOKEN or GITHUB_TOKEN is required');
    this.repository = repository;
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.now = now;
    this.retries = retries;
    this.minWriteIntervalMs = minWriteIntervalMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.assetTimeoutMs = assetTimeoutMs;
    this.maxRetryDelayMs = maxRetryDelayMs;
    this.deadline = deadline;
    this.writeQueue = Promise.resolve();
    this.lastWriteAt = null;
  }

  #url(path) {
    return new URL(path.startsWith('https://') ? path : `/repos/${this.repository}${path}`, API);
  }

  #headers(url, extra = {}) {
    const headers = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'financial-data-snapshot',
      'X-GitHub-Api-Version': '2022-11-28',
      ...extra,
    };
    // Signed object-storage redirects must never receive the repository token.
    if (url.origin === API || url.origin === 'https://uploads.github.com') {
      headers.Authorization = `Bearer ${this.token}`;
    }
    return headers;
  }

  #remainingTime(requiredMs = 0) {
    const remaining = this.deadline - this.now();
    if (!(remaining > requiredMs)) {
      throw new GitHubError('GitHub finalization deadline reached; checkpoint retained for the next run');
    }
    return remaining;
  }

  #requestSignal(timeoutMs) {
    // The fetch signal also bounds reading its response body and upload stream.
    return AbortSignal.timeout(Math.max(1, Math.floor(Math.min(timeoutMs, this.#remainingTime()))));
  }

  async #sleep(ms) {
    this.#remainingTime(ms);
    await this.sleep(ms);
    this.#remainingTime();
  }

  async #write(action) {
    const slot = this.writeQueue.then(async () => {
      if (this.lastWriteAt !== null) {
        const wait = this.lastWriteAt + this.minWriteIntervalMs - this.now();
        if (wait > 0) await this.#sleep(wait);
      }
      this.#remainingTime();
      this.lastWriteAt = this.now();
      return action();
    });
    this.writeQueue = slot.catch(() => {});
    return slot;
  }

  async #checkResponse(response, operation) {
    if (response.ok) return response;
    const text = (await response.text()).slice(0, 1_000);
    const retryAfter = response.headers.get('retry-after');
    const exhausted = response.headers.get('x-ratelimit-remaining') === '0';
    const rateLimited = response.status === 429 || (response.status === 403 &&
      (retryAfter !== null || exhausted || /(?:secondary )?rate limit|abuse detection/i.test(text)));
    let retryAfterMs;
    if (retryAfter !== null) {
      const seconds = Number(retryAfter);
      retryAfterMs = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(retryAfter) - this.now();
    }
    if (exhausted) {
      const reset = Number(response.headers.get('x-ratelimit-reset')) * 1_000 - this.now() + 1_000;
      if (Number.isFinite(reset)) retryAfterMs = Math.max(retryAfterMs || 0, reset);
    }
    if (rateLimited && !Number.isFinite(retryAfterMs)) retryAfterMs = 60_000;
    throw new GitHubError(`${operation}: HTTP ${response.status}: ${text}`, {
      status: response.status,
      retryAfterMs: Number.isFinite(retryAfterMs) ? Math.max(0, retryAfterMs) : undefined,
      retryable: rateLimited || response.status >= 500,
    });
  }

  async #retry(operation) {
    for (let attempt = 0; ; attempt += 1) {
      this.#remainingTime();
      try {
        return await operation(attempt);
      } catch (error) {
        const retryable = error instanceof GitHubError ? error.retryable :
          error.name === 'TimeoutError' || error.name === 'AbortError' ||
          error instanceof TypeError || ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE'].includes(error.code);
        if (!retryable || attempt >= this.retries) throw error;
        const wait = Math.max(error.retryAfterMs || 0, Math.min(60_000, 1_000 * 2 ** attempt));
        if (wait > this.maxRetryDelayMs) {
          throw new GitHubError(`GitHub requested a ${Math.ceil(wait / 1_000)}s retry delay; checkpoint retained for the next run`, {
            status: error.status,
            retryAfterMs: wait,
          });
        }
        await this.#sleep(wait);
      }
    }
  }

  async #json(method, path, body) {
    return this.#retry(async () => {
      const url = this.#url(path);
      if (url.origin !== API) throw new Error('Refusing authenticated API request outside api.github.com');
      const request = () => this.fetchImpl(url, {
        method,
        headers: this.#headers(url, body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: this.#requestSignal(this.requestTimeoutMs),
      });
      const response = await (method === 'GET' ? request() : this.#write(request));
      await this.#checkResponse(response, method);
      return response.status === 204 ? undefined : response.json();
    });
  }

  async #list(path) {
    const items = [];
    for (let page = 1; ; page += 1) {
      const batch = await this.#json('GET', `${path}?per_page=100&page=${page}`);
      if (!Array.isArray(batch)) throw new Error('GitHub returned an invalid paginated listing');
      items.push(...batch);
      if (batch.length < 100) return items;
    }
  }

  listReleases() { return this.#list('/releases'); }
  listAssets(releaseId) { return this.#list(`/releases/${releaseId}/assets`); }
  getRelease(releaseId) { return this.#json('GET', `/releases/${releaseId}`); }
  createDraft({ tag, body, target }) {
    return this.#json('POST', '/releases', {
      tag_name: tag,
      name: tag,
      body,
      ...(target ? { target_commitish: target } : {}),
      draft: true,
      prerelease: false,
    });
  }
  publish(releaseId) {
    return this.#json('PATCH', `/releases/${releaseId}`, { draft: false, make_latest: 'true' });
  }
  deleteRelease(releaseId) { return this.#json('DELETE', `/releases/${releaseId}`); }
  deleteAsset(assetId) { return this.#json('DELETE', `/releases/assets/${assetId}`); }
  renameAsset(assetId, name) {
    return this.#json('PATCH', `/releases/assets/${assetId}`, { name });
  }
  deleteTag(tag) { return this.#json('DELETE', `/git/refs/tags/${encodeURIComponent(tag)}`); }

  async listScheduledRuns(workflow, { signal } = {}) {
    if (!/^[\w.-]+\.ya?ml$/.test(workflow)) throw new Error('Expected a workflow YAML filename');
    signal?.throwIfAborted();
    const url = this.#url(`/actions/workflows/${encodeURIComponent(workflow)}/runs?event=schedule&per_page=100`);
    // A live attempt lasts under six hours: the newest 100 weekly scheduled runs
    // cover every possible successor. Polling retries on its next tick, rather
    // than holding up a checkpoint with release-transfer retry/backoff settings.
    const timeout = this.#requestSignal(Math.min(this.requestTimeoutMs, 10_000));
    const response = await this.fetchImpl(url, {
      headers: this.#headers(url), redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    await this.#checkResponse(response, 'Read scheduled workflow runs');
    const result = await response.json();
    if (!Array.isArray(result.workflow_runs)) throw new Error('Invalid scheduled workflow run listing');
    return result.workflow_runs;
  }

  async downloadAsset(asset, destination) {
    await mkdir(dirname(destination), { recursive: true });
    return this.#retry(async () => {
      let url = this.#url(`/releases/assets/${asset.id}`);
      let response;
      for (let redirects = 0; ; redirects += 1) {
        response = await this.fetchImpl(url, {
          headers: this.#headers(url, { Accept: 'application/octet-stream' }),
          redirect: 'manual',
          signal: this.#requestSignal(this.assetTimeoutMs),
        });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        await response.body?.cancel();
        if (redirects >= 5) throw new Error('Too many redirects downloading a release asset');
        const location = response.headers.get('location');
        if (!location) throw new Error('Asset redirect has no Location header');
        url = new URL(location, url);
        if (url.protocol !== 'https:') throw new Error('Refusing insecure release asset redirect');
      }
      await this.#checkResponse(response, `Download ${asset.name}`);
      const temporary = `${destination}.${randomUUID()}.tmp`;
      const hash = createHash('sha256');
      let size = 0;
      const count = new Transform({
        transform(chunk, encoding, callback) {
          size += chunk.length;
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      try {
        if (!response.body) throw new Error('Asset response has no body');
        await pipeline(Readable.fromWeb(response.body), count, createWriteStream(temporary, { flags: 'wx' }));
        if (Number.isInteger(asset.size) && size !== asset.size) throw new Error(`Downloaded size mismatch for ${asset.name}`);
        const sha256 = hash.digest('hex');
        if (asset.digest?.startsWith('sha256:') && asset.digest !== `sha256:${sha256}`) {
          throw new Error(`Downloaded checksum mismatch for ${asset.name}`);
        }
        await rename(temporary, destination);
        return { path: destination, size, sha256 };
      } finally {
        await rm(temporary, { force: true });
      }
    });
  }

  async uploadAsset(release, filePath, name = basename(filePath)) {
    this.#remainingTime();
    const info = await stat(filePath);
    if (info.size >= MAX_ASSET_BYTES) throw new Error(`Release asset ${name} must be smaller than 2 GiB`);
    const uploadUrl = new URL((release.upload_url || '').replace(/\{.*$/, ''));
    if (uploadUrl.origin !== 'https://uploads.github.com') throw new Error('Unexpected GitHub release upload URL');
    uploadUrl.searchParams.set('name', name);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filePath)) {
      this.#remainingTime();
      hash.update(chunk);
    }
    const digest = `sha256:${hash.digest('hex')}`;

    let removedStarter = false;
    const recover = async () => {
      const existing = (await this.listAssets(release.id)).find((asset) => asset.name === name);
      if (existing?.state === 'uploaded' && existing.size === info.size && existing.digest === digest) return existing;
      // GitHub can leave an empty "starter" asset after a failed 502 upload.
      if (existing?.state === 'starter') {
        await this.deleteAsset(existing.id);
        removedStarter = true;
      }
      return undefined;
    };

    return this.#retry(async (attempt) => {
      removedStarter = false;
      if (attempt > 0) {
        const recovered = await recover();
        if (recovered) return recovered;
      }
      const stream = createReadStream(filePath);
      try {
        const response = await this.#write(() => this.fetchImpl(uploadUrl, {
          method: 'POST',
          headers: this.#headers(uploadUrl, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(info.size),
          }),
          body: stream,
          duplex: 'half',
          redirect: 'error',
          signal: this.#requestSignal(this.assetTimeoutMs),
        }));
        if (response.status === 422) {
          const recovered = await recover();
          if (recovered) {
            await response.body?.cancel();
            return recovered;
          }
          if (removedStarter) {
            await response.body?.cancel();
            throw new GitHubError(`Removed an incomplete previous upload of ${name}`, { retryable: true });
          }
        }
        await this.#checkResponse(response, `Upload ${name}`);
        const asset = await response.json();
        if (asset.state !== 'uploaded' || asset.size !== info.size ||
            (asset.digest && asset.digest !== digest)) {
          throw new Error(`GitHub did not confirm a complete upload of ${name}`);
        }
        return asset;
      } finally {
        stream.destroy();
      }
    });
  }
}
