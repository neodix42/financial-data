import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';

export const CSV_HEADER = 'timestamp,open,high,low,close,volume\n';
const DURATIONS = { h1: 3_600_000, d1: 86_400_000 };
const DEFAULT_MAX_BYTES = Math.floor(1.8 * 1024 ** 3);

function epoch(value, label) {
  const result = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isSafeInteger(result)) throw new Error(`Invalid ${label}: ${value}`);
  return result;
}

function validatePrices(values) {
  if (values.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error('Non-finite OHLCV value');
  }
  const [openPrice, high, low, close, volume] = values;
  if (high < Math.max(openPrice, close, low) || low > Math.min(openPrice, close, high) || volume < 0) {
    throw new Error('Invalid OHLCV range');
  }
}

function normalizeBars(bars, { from, cutoff, period }) {
  const duration = DURATIONS[period];
  if (!duration) throw new Error(`Unsupported period: ${period}`);
  const start = epoch(from, 'from');
  const end = epoch(cutoff, 'cutoff');
  const unique = new Map();
  for (const bar of bars) {
    const timestamp = epoch(bar.timestamp, 'bar timestamp');
    const values = [bar.open, bar.high, bar.low, bar.close, bar.volume];
    validatePrices(values);
    if (timestamp < start || timestamp + duration > end) continue;
    unique.set(timestamp, { timestamp, line: `${new Date(timestamp).toISOString()},${values.join(',')}\n` });
  }
  return [...unique.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function parseRow(line) {
  const fields = line.split(',');
  if (fields.length !== 6 || fields.some(field => field === '')) throw new Error('Invalid CSV row');
  const timestamp = epoch(fields[0], 'CSV timestamp');
  if (new Date(timestamp).toISOString() !== fields[0]) throw new Error('CSV timestamp must be ISO UTC');
  validatePrices(fields.slice(1).map(Number));
  return timestamp;
}

async function* linesWithOffsets(path) {
  let pending = Buffer.alloc(0);
  let offset = 0;
  for await (const chunk of createReadStream(path)) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let start = 0;
    let newline;
    while ((newline = pending.indexOf(10, start)) !== -1) {
      const raw = pending.subarray(start, newline);
      if (raw.includes(13)) throw new Error('CSV must use LF line endings');
      if (raw.length > 4096) throw new Error('CSV row exceeds maximum length');
      yield { line: raw.toString('utf8'), offset };
      offset += newline - start + 1;
      start = newline + 1;
    }
    pending = pending.subarray(start);
    if (pending.length > 4096) throw new Error('CSV row exceeds maximum length');
  }
  if (pending.length) throw new Error('CSV must end with a newline');
}

export async function inspectCsv(path) {
  const summary = { first: null, last: null, rows: 0, lastOffset: null, bytes: 0 };
  let header = false;
  let previous = -Infinity;
  for await (const { line, offset } of linesWithOffsets(path)) {
    if (!header) {
      if (`${line}\n` !== CSV_HEADER) throw new Error('Invalid CSV header');
      header = true;
      summary.bytes = Buffer.byteLength(CSV_HEADER);
      continue;
    }
    const timestamp = parseRow(line);
    if (timestamp <= previous) throw new Error('CSV timestamps must be ascending and unique');
    previous = timestamp;
    summary.first ??= new Date(timestamp).toISOString();
    summary.last = new Date(timestamp).toISOString();
    summary.rows += 1;
    summary.lastOffset = offset;
    summary.bytes = offset + Buffer.byteLength(line) + 1;
  }
  if (!header) throw new Error('CSV is empty');
  return summary;
}

async function existingSummary(path, candidate) {
  const info = await stat(path).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return null;
  if (candidate && candidate.bytes === info.size && Number.isSafeInteger(candidate.rows) && candidate.rows >= 0) {
    if (candidate.rows === 0 && candidate.bytes === Buffer.byteLength(CSV_HEADER)) return candidate;
    if (candidate.rows > 0 && Number.isSafeInteger(candidate.lastOffset) && candidate.lastOffset >= Buffer.byteLength(CSV_HEADER)) {
      const handle = await open(path, 'r');
      try {
        const length = candidate.bytes - candidate.lastOffset;
        if (length > 0 && length < 4096) {
          const buffer = Buffer.alloc(length);
          const { bytesRead } = await handle.read(buffer, 0, length, candidate.lastOffset);
          if (bytesRead === length && buffer.at(-1) === 10 && parseRow(buffer.subarray(0, -1).toString()) === epoch(candidate.last, 'summary last')) {
            return candidate;
          }
        }
      } finally {
        await handle.close();
      }
    }
  }
  return inspectCsv(path);
}

async function writeAll(handle, buffer, position) {
  let written = 0;
  while (written < buffer.length) {
    const result = await handle.write(buffer, written, buffer.length - written, position + written);
    if (!result.bytesWritten) throw new Error('Unable to write CSV');
    written += result.bytesWritten;
  }
}

/** Merge one downloaded chunk. Pass the last returned summary to avoid rescanning history. */
export async function mergeBars(path, bars, options) {
  const incoming = normalizeBars(bars, options);
  await mkdir(dirname(path), { recursive: true });
  let summary = await existingSummary(path, options.summary);
  if (!summary) {
    const handle = await open(path, 'wx');
    try { await handle.writeFile(CSV_HEADER); } finally { await handle.close(); }
    summary = { first: null, last: null, rows: 0, lastOffset: null, bytes: Buffer.byteLength(CSV_HEADER) };
  }
  if (!incoming.length) return { ...summary };
  const previousLast = summary.last === null ? -Infinity : epoch(summary.last, 'summary last');
  if (incoming[0].timestamp >= previousLast) {
    const replacing = incoming[0].timestamp === previousLast;
    let offset = replacing ? summary.lastOffset : summary.bytes;
    const result = { ...summary, rows: summary.rows - Number(replacing) };
    const handle = await open(path, 'r+');
    try {
      for (const item of incoming) {
        const buffer = Buffer.from(item.line);
        await writeAll(handle, buffer, offset);
        result.lastOffset = offset;
        offset += buffer.length;
        if (!result.rows) result.first = new Date(item.timestamp).toISOString();
        result.last = new Date(item.timestamp).toISOString();
        result.rows += 1;
      }
      await handle.truncate(offset);
      result.bytes = offset;
      return result;
    } finally { await handle.close(); }
  }

  // A wider overlap is uncommon; merge it by streaming the old history once.
  const temporary = `${path}.${randomUUID()}.tmp`;
  const output = createWriteStream(temporary, { flags: 'wx' });
  const outputFinished = finished(output);
  // Retain the rejection for the awaited finish below without allowing an
  // early filesystem error to become an unhandled promise rejection.
  outputFinished.catch(() => {});
  const result = { first: null, last: null, rows: 0, lastOffset: null, bytes: Buffer.byteLength(CSV_HEADER) };
  let index = 0;
  let oldTimestamp = -Infinity;
  const write = async line => {
    if (!output.write(line)) await once(output, 'drain');
  };
  const add = async (timestamp, line) => {
    await write(line);
    result.first ??= new Date(timestamp).toISOString();
    result.last = new Date(timestamp).toISOString();
    result.lastOffset = result.bytes;
    result.bytes += Buffer.byteLength(line);
    result.rows += 1;
  };
  try {
    await write(CSV_HEADER);
    let header = false;
    for await (const { line } of linesWithOffsets(path)) {
      if (!header) {
        if (`${line}\n` !== CSV_HEADER) throw new Error('Invalid CSV header');
        header = true;
        continue;
      }
      const timestamp = parseRow(line);
      if (timestamp <= oldTimestamp) throw new Error('CSV timestamps must be ascending and unique');
      oldTimestamp = timestamp;
      while (index < incoming.length && incoming[index].timestamp < timestamp) {
        await add(incoming[index].timestamp, incoming[index].line);
        index += 1;
      }
      if (index < incoming.length && incoming[index].timestamp === timestamp) {
        await add(timestamp, incoming[index].line);
        index += 1;
      } else {
        await add(timestamp, `${line}\n`);
      }
    }
    while (index < incoming.length) {
      await add(incoming[index].timestamp, incoming[index].line);
      index += 1;
    }
    output.end();
    await outputFinished;
    await rename(temporary, path);
    return result;
  } catch (error) {
    output.destroy();
    await rm(temporary, { force: true });
    throw error;
  }
}

function flatName(name) {
  if (!name || name === '.' || name === '..' || name !== basename(name) || /[\r\n\x00\\]/.test(name)) {
    throw new Error(`Unsafe archive member: ${name}`);
  }
  return name;
}

function command(program, args, options = {}) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(program, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > 8 * 1024 * 1024) child.kill();
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16_384); });
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0) resolveCommand(stdout);
      else reject(new Error(`${program} failed (${code}): ${stderr.trim()}`));
    });
  });
}

export async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function zipCsv(csvPath, zipPath) {
  flatName(basename(csvPath));
  await mkdir(dirname(zipPath), { recursive: true });
  const temporary = `${resolve(zipPath)}.${randomUUID()}.zip`;
  try {
    await command('zip', ['-q', '-j', temporary, resolve(csvPath)]);
    await command('unzip', ['-tqq', temporary]);
    await rename(temporary, zipPath);
  } finally { await rm(temporary, { force: true }); }
}

export async function unzipCsv(zipPath, directory, expectedName) {
  flatName(expectedName);
  const names = (await command('unzip', ['-Z1', resolve(zipPath)])).trimEnd().split('\n');
  if (names.length !== 1 || names[0] !== expectedName) throw new Error('ZIP must contain exactly the expected CSV');
  await command('unzip', ['-tqq', resolve(zipPath)]);
  await mkdir(directory, { recursive: true });
  const target = join(directory, expectedName);
  // Extract to stdout rather than honoring ZIP member modes or symbolic links.
  const handle = await open(target, 'wx');
  try {
    await new Promise((resolveCommand, reject) => {
      const child = spawn('unzip', ['-p', resolve(zipPath), expectedName], { stdio: ['ignore', handle.fd, 'pipe'] });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16_384); });
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolveCommand() : reject(new Error(`unzip failed (${code}): ${stderr}`)));
    });
  } catch (error) {
    await rm(target, { force: true });
    throw error;
  } finally { await handle.close(); }
  return target;
}

function tarSize(files) {
  // GNU tar pads records to 10 KiB by default, including two terminal blocks.
  return Math.ceil((files.reduce((sum, file) => sum + 512 + Math.ceil(file.size / 512) * 512, 0) + 1024) / 10240) * 10240;
}

export async function packFiles(files, outputDirectory, prefix, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  flatName(prefix);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 10240 || maxBytes >= 2 * 1024 ** 3) {
    throw new Error('Archive size bound must be at least 10 KiB and below 2 GiB');
  }
  const seen = new Set();
  const inputs = [];
  for (const path of [...files].sort((a, b) => basename(a).localeCompare(basename(b)))) {
    const name = flatName(basename(path));
    if (Buffer.byteLength(name) > 100) throw new Error('TAR member name exceeds portable header length');
    if (seen.has(name)) throw new Error(`Duplicate archive member: ${name}`);
    seen.add(name);
    const info = await stat(path);
    if (!info.isFile()) throw new Error(`Archive input is not a regular file: ${path}`);
    const input = { path: resolve(path), name, size: info.size };
    if (tarSize([input]) > maxBytes) throw new Error(`Single member exceeds archive size bound: ${name}`);
    inputs.push(input);
  }
  await mkdir(outputDirectory, { recursive: true });
  const groups = [];
  let current = [];
  for (const input of inputs) {
    if (tarSize([...current, input]) > maxBytes) {
      groups.push(current);
      current = [];
    }
    current.push(input);
  }
  if (current.length) groups.push(current);
  const result = [];
  for (const [index, group] of groups.entries()) {
    const name = `${prefix}-part${String(index + 1).padStart(3, '0')}.tar`;
    const path = resolve(outputDirectory, name);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      // -C applies separately to each flat member, supporting inputs in different directories.
      const args = ['--format=ustar', '-cf', temporary];
      for (const input of group) args.push('-C', dirname(input.path), '--add-file', input.name);
      await command('tar', args);
      const info = await stat(temporary);
      if (info.size > maxBytes || info.size >= 2 * 1024 ** 3) throw new Error(`Archive exceeds size bound: ${name}`);
      await rename(temporary, path);
      result.push({ path, name, size: info.size, sha256: await sha256(path), members: group.map(input => input.name) });
    } finally { await rm(temporary, { force: true }); }
  }
  return result;
}

export async function extractTar(archivePath, directory, { allowedNames } = {}) {
  const archive = resolve(archivePath);
  const names = (await command('tar', ['-tf', archive])).trimEnd().split('\n').filter(Boolean);
  const verbose = (await command('tar', ['-tvf', archive])).trimEnd().split('\n').filter(Boolean);
  if (names.length !== verbose.length || verbose.some(line => !line.startsWith('-'))) {
    throw new Error('TAR may contain regular files only');
  }
  const allowed = allowedNames ? new Set(allowedNames) : null;
  const seen = new Set();
  for (const name of names) {
    flatName(name);
    if (seen.has(name)) throw new Error(`Duplicate TAR member: ${name}`);
    if (allowed && !allowed.has(name)) throw new Error(`Unexpected TAR member: ${name}`);
    seen.add(name);
  }
  await mkdir(directory, { recursive: true });
  await command('tar', ['-xf', archive, '-C', resolve(directory), '--no-same-owner', '--no-same-permissions', '--keep-old-files']);
  return names.map(name => join(directory, name));
}
