const ACTIVE_STATUSES = new Set(['queued', 'pending', 'waiting', 'requested', 'in_progress']);
const MAX_TIMER_MS = 2 ** 31 - 1;

function positiveInteger(value, label) {
  const number = Number(value);
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return number;
}

/** A queued Saturday run requests a checkpoint; it never force-cancels the runner. */
export class ScheduledHandoff {
  constructor({ client, workflow, runId, runNumber, intervalMs = 30_000, log = console.log }) {
    if (typeof client?.listScheduledRuns !== 'function') throw new Error('Handoff client must list scheduled workflow runs');
    if (typeof workflow !== 'string' || !workflow.trim()) throw new Error('Workflow filename or ID is required');
    if (typeof log !== 'function') throw new Error('Handoff logger must be a function');
    this.client = client;
    this.workflow = workflow;
    this.runId = positiveInteger(runId, 'Workflow run ID');
    this.runNumber = positiveInteger(runNumber, 'Workflow run number');
    this.intervalMs = positiveInteger(intervalMs, 'Handoff polling interval');
    this.log = log;
    this.started = false;
    this.closed = false;
    this.requested = false;
    this.inFlight = null;
    this.controller = null;
    this.timer = null;
  }

  /** Poll immediately; later matches invoke the same callback exactly once. */
  async start(onRequest) {
    if (this.started || this.closed) throw new Error('Scheduled handoff monitor cannot be started twice or after closing');
    if (typeof onRequest !== 'function') throw new Error('Handoff request callback is required');
    this.started = true;
    this.onRequest = onRequest;
    return this.#poll();
  }

  #matches(run) {
    return run?.event === 'schedule' && ACTIVE_STATUSES.has(run.status) &&
      Number.isSafeInteger(run.id) && run.id > 0 && run.id !== this.runId &&
      Number.isSafeInteger(run.run_number) && run.run_number > this.runNumber;
  }

  #poll() {
    if (this.closed || this.requested) return Promise.resolve(null);
    if (this.inFlight) return this.inFlight;
    const controller = new AbortController();
    this.controller = controller;
    this.inFlight = (async () => {
      let nextDelay = this.intervalMs;
      try {
        // Normalize even a synchronously throwing client into a rejected promise
        // so inFlight is assigned before the poll's cleanup runs.
        const request = async () => this.client.listScheduledRuns(this.workflow, { signal: controller.signal });
        const runs = await request();
        if (this.closed || controller.signal.aborted) return null;
        if (!Array.isArray(runs)) throw new Error('GitHub returned an invalid workflow-run list');
        const match = runs.filter(run => this.#matches(run))
          .sort((a, b) => b.run_number - a.run_number)[0];
        if (!match) return null;
        this.requested = true;
        this.log(`Scheduled workflow run ${match.id} is waiting; requesting a safe checkpoint and handoff.`);
        await this.onRequest(match);
        return match;
      } catch (error) {
        if (!this.closed && !controller.signal.aborted && error.name !== 'AbortError') {
          if (Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0) {
            nextDelay = Math.max(nextDelay, error.retryAfterMs);
          }
          this.log(`::warning::Scheduled handoff check failed: ${error.message}; will retry later.`);
        }
        return null;
      } finally {
        this.controller = null;
        this.inFlight = null;
        if (!this.closed && !this.requested) {
          this.timer = setTimeout(() => { this.timer = null; void this.#poll(); }, Math.min(nextDelay, MAX_TIMER_MS));
        }
      }
    })();
    return this.inFlight;
  }

  /** Stop polling and wait for an abort-aware outstanding read to settle. */
  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = null;
    this.controller?.abort();
    await this.inFlight;
  }
}
