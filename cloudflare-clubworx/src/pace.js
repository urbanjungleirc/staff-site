/**
 * The Clubworx pace: 75 requests per minute, one in flight.
 *
 * Measured, not guessed. staff-site#51 spent requests faster than ~3/s and got
 * roughly **50** through before the API answered `429` for about **18 seconds**.
 * 75/min ran clean; 120/min did not. See `probes/51-events-and-burst.md`.
 *
 * Two properties of Clubworx make this a design constant rather than an
 * adaptive one, and both are load-bearing:
 *
 *   - **No rate-limit headers exist.** Not `Retry-After`, not `X-RateLimit-*`,
 *     not at any point — confirmed live, and confirmed again *while being
 *     throttled*. There is nothing to read back, so a client cannot discover it
 *     is approaching a ceiling. It can only hit one.
 *   - **The allowance is gym-wide.** One key per gym (#47), so the roster Worker
 *     and n8n spend from the same budget, unseen. Being under the ceiling alone
 *     is not the same as being under it.
 *
 * **Concurrency is the wrong lever.** The ceiling is on requests, not on
 * connections, so running two at once buys nothing and reaches the wall sooner.
 * This module therefore serialises rather than pooling: one in flight, and a
 * minimum gap between the moments two calls *start*.
 *
 * Scope, honestly: a pacer instance paces the calls made through it. The whole
 * pipeline is strictly serial by design — the browser sends one student at a
 * time and waits, and the Worker paces its own calls inside that — so the
 * aggregate rate stays under the ceiling without a global governor (§6). This
 * is not a distributed rate limiter and does not pretend to be one.
 */

/** The rate #51 measured as running clean. */
export const MAX_REQUESTS_PER_MINUTE = 75;

/**
 * Derived, so the two can never disagree. A hand-written 800 beside a changed
 * rate is the standard way a pacing constant goes quietly wrong.
 */
export const MIN_INTERVAL_MS = Math.ceil(60_000 / MAX_REQUESTS_PER_MINUTE);

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Build a pacer: a function that runs tasks one at a time, no sooner than
 * `minIntervalMs` after the previous one started.
 *
 * @param {object} [opts]
 * @param {number} [opts.minIntervalMs] Minimum gap between two starts. May be
 *   slower than the measured pace, never faster.
 * @param {() => number} [opts.now]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @returns {(<T>(task: () => Promise<T>) => Promise<T>) & { calls: number }}
 */
export function createPacer({
  minIntervalMs = MIN_INTERVAL_MS,
  now = Date.now,
  sleep = defaultSleep,
} = {}) {
  if (minIntervalMs < MIN_INTERVAL_MS) {
    throw new Error(
      `createPacer: ${minIntervalMs}ms is faster than the measured pace; ` +
        `${MIN_INTERVAL_MS}ms or slower only`,
    );
  }

  // The queue is a promise chain rather than an array, so ordering is the
  // language's problem rather than this module's.
  let tail = Promise.resolve();
  let lastStartedAt = null;

  const run = task => {
    const queued = tail.then(async () => {
      if (lastStartedAt !== null) {
        // A call that took longer than the interval has already spent it. The
        // ceiling is on how often a request *starts*, so waiting again here
        // would halve the achievable rate for nothing.
        const wait = lastStartedAt + minIntervalMs - now();
        if (wait > 0) await sleep(wait);
      }
      lastStartedAt = now();
      run.calls += 1;
      return task();
    });

    // The chain continues on a settled promise, not a rejected one. Without
    // this, one 500 from Clubworx mid-run strands every remaining student
    // behind an unhandled rejection — the caller still sees the failure,
    // because `queued` is what is returned.
    tail = queued.then(
      () => undefined,
      () => undefined,
    );

    return queued;
  };

  run.calls = 0;
  return run;
}

/**
 * The pacer every Clubworx client uses unless it is handed another one.
 *
 * Module scope, deliberately. The account key comes from `env`, so the natural
 * way to wire a client is to build one per request — and a pacer created inside
 * that constructor would reset with it, leaving "one in flight" true only
 * within a single request while the gym-wide ceiling it is protecting is not
 * per-request at all. One pacer per isolate is the smallest thing that is
 * actually the property being claimed.
 */
export const sharedPacer = createPacer();
