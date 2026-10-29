import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { ScheduledHandoff } from '../scripts/handoff.mjs';

const waiting = (overrides = {}) => ({ id: 200, run_number: 20, event: 'schedule', status: 'queued', ...overrides });
const options = client => ({ client, workflow: 'historical-data.yml', runId: '100', runNumber: '10', intervalMs: 10, log: () => {} });

test('immediate check ignores self, old, terminal and manual runs and selects the newest waiting Saturday run once', async () => {
  let polls = 0;
  const received = [];
  const handoff = new ScheduledHandoff(options({
    async listScheduledRuns(workflow, { signal }) {
      polls += 1;
      assert.equal(workflow, 'historical-data.yml');
      assert.equal(signal.aborted, false);
      return [waiting({ id: 100, run_number: 99 }), waiting({ id: 1, run_number: 1 }),
        waiting({ id: 300, run_number: 30, status: 'completed' }),
        waiting({ id: 400, run_number: 40, event: 'workflow_dispatch' }),
        waiting({ id: 450, run_number: 45, status: 'cancelled' }),
        waiting(), waiting({ id: 201, run_number: 21, status: 'pending' })];
    },
  }));
  try {
    const match = await handoff.start(run => received.push(run.id));
    assert.equal(match.id, 201);
    await delay(35);
    assert.deepEqual(received, [201]);
    assert.equal(polls, 1, 'a successful request stops polling');
  } finally { await handoff.close(); }
});

test('checks continue after no match, never overlap, and stop after a later handoff', async () => {
  let active = 0;
  let maximumActive = 0;
  let polls = 0;
  let notify;
  const requested = new Promise(resolve => { notify = resolve; });
  const handoff = new ScheduledHandoff(options({
    async listScheduledRuns() {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      polls += 1;
      await delay(15);
      active -= 1;
      return polls === 1 ? [] : [waiting()];
    },
  }));
  try {
    assert.equal(await handoff.start(notify), null);
    const run = await Promise.race([requested, delay(500).then(() => { throw new Error('Handoff was not requested'); })]);
    assert.equal(run.id, 200);
    assert.equal(maximumActive, 1);
    await handoff.close();
    const before = polls;
    await delay(25);
    assert.equal(polls, before);
  } finally { await handoff.close(); }
});

test('transient polling failures warn and retry on the next interval', async () => {
  let polls = 0;
  const warnings = [];
  let notify;
  const requested = new Promise(resolve => { notify = resolve; });
  const handoff = new ScheduledHandoff({ ...options({
    async listScheduledRuns() {
      polls += 1;
      if (polls === 1) throw new Error('temporary network failure');
      return [waiting()];
    },
  }), log: message => warnings.push(message) });
  try {
    assert.equal(await handoff.start(notify), null);
    await Promise.race([requested, delay(500).then(() => { throw new Error('Polling did not retry'); })]);
    assert.equal(polls, 2);
    assert.match(warnings[0], /warning.*temporary network failure/);
  } finally { await handoff.close(); }
});

test('rate-limit retry delay is respected before polling again', async () => {
  let polls = 0;
  let failedAt;
  let notify;
  const requested = new Promise(resolve => { notify = resolve; });
  const handoff = new ScheduledHandoff(options({
    async listScheduledRuns() {
      polls += 1;
      if (polls === 1) {
        failedAt = Date.now();
        throw Object.assign(new Error('rate limited'), { retryAfterMs: 70 });
      }
      assert.ok(Date.now() - failedAt >= 60, 'retry must wait for GitHub backoff');
      return [waiting()];
    },
  }));
  try {
    await handoff.start(notify);
    await delay(25);
    assert.equal(polls, 1);
    await Promise.race([requested, delay(500).then(() => { throw new Error('Polling did not resume'); })]);
    assert.equal(polls, 2);
  } finally { await handoff.close(); }
});

test('close aborts an outstanding read, waits for it to settle and schedules nothing else', async () => {
  let observedSignal;
  let settled = false;
  let polls = 0;
  const messages = [];
  const handoff = new ScheduledHandoff({ ...options({
    async listScheduledRuns(workflow, { signal }) {
      polls += 1;
      observedSignal = signal;
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          settled = true;
          reject(new DOMException('Monitor closed', 'AbortError'));
        }, { once: true });
      });
    },
  }), log: message => messages.push(message) });
  const starting = handoff.start(() => assert.fail('aborted polling must not request handoff'));
  await handoff.close();
  await starting;
  assert.equal(observedSignal.aborted, true);
  assert.equal(settled, true);
  await delay(25);
  assert.equal(polls, 1);
  assert.deepEqual(messages, []);
});

test('callback errors are contained and do not request the same handoff twice', async () => {
  let calls = 0;
  const messages = [];
  const handoff = new ScheduledHandoff({ ...options({ async listScheduledRuns() { return [waiting()]; } }), log: message => messages.push(message) });
  try {
    assert.equal(await handoff.start(() => { calls += 1; throw new Error('callback failed'); }), null);
    await delay(25);
    assert.equal(calls, 1);
    assert.ok(messages.some(message => message.includes('callback failed')));
  } finally { await handoff.close(); }
});

test('constructor rejects invalid workflow-run environment values and lifecycle misuse', async () => {
  const base = options({ async listScheduledRuns() { return []; } });
  for (const runId of ['', '0', '-1', '1e3', 'not-a-number', 1.5]) {
    assert.throws(() => new ScheduledHandoff({ ...base, runId }), /positive safe integer/);
  }
  assert.throws(() => new ScheduledHandoff({ ...base, runNumber: 0 }), /positive safe integer/);
  assert.throws(() => new ScheduledHandoff({ ...base, workflow: '' }), /Workflow filename/);
  const handoff = new ScheduledHandoff(base);
  await handoff.close();
  await assert.rejects(handoff.start(() => {}), /after closing/);
});
