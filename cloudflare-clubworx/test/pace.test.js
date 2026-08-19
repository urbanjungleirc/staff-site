import { describe, it, expect } from 'vitest';
import { createPacer, MAX_REQUESTS_PER_MINUTE, MIN_INTERVAL_MS } from '../src/pace.js';

// The pace is a design constant, not an adaptive one. Clubworx advertises no
// rate-limit headers at any point — confirmed live, and confirmed again while
// being throttled (#51) — so there is nothing to read back and self-throttle
// from. These tests pin the constant and the seriality, because the only other
// way to find out the pacer is broken is a gym-wide 18-second outage.

/**
 * A virtual clock, so the tests assert the schedule rather than sleep through it.
 * `sleep` advances time instead of waiting, which is what makes an 800 ms gap
 * assertable in a millisecond.
 */
function virtualClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async ms => {
      t += ms;
    },
    advance: ms => {
      t += ms;
    },
    set: ms => {
      t = ms;
    },
  };
}

describe('the measured constants', () => {
  it('paces at 75 requests per minute, the rate #51 found ran clean', () => {
    expect(MAX_REQUESTS_PER_MINUTE).toBe(75);
  });

  it('derives the interval from the rate rather than restating it', () => {
    // 60000/75 = 800. Derived so that changing the rate cannot leave a stale
    // interval behind, which is the failure mode of two hand-kept constants.
    expect(MIN_INTERVAL_MS).toBe(Math.ceil(60_000 / MAX_REQUESTS_PER_MINUTE));
    expect(MIN_INTERVAL_MS).toBe(800);
  });
});

describe('createPacer', () => {
  it('runs one request at a time, never two in flight', async () => {
    const clock = virtualClock();
    const pace = createPacer(clock);

    let inFlight = 0;
    let maxInFlight = 0;
    const task = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return 'done';
    };

    await Promise.all([pace(task), pace(task), pace(task)]);

    expect(maxInFlight).toBe(1);
  });

  it('leaves at least the interval between the starts of two calls', async () => {
    const clock = virtualClock();
    const pace = createPacer(clock);
    const starts = [];

    await pace(async () => starts.push(clock.now()));
    await pace(async () => starts.push(clock.now()));
    await pace(async () => starts.push(clock.now()));

    expect(starts).toEqual([0, 800, 1600]);
  });

  it('does not wait when the caller was already slow enough', async () => {
    // A Clubworx call that itself takes a second has already spent the interval.
    // Sleeping another 800 ms on top would halve the achievable rate for no
    // reason — the ceiling is on how often a request *starts*.
    const clock = virtualClock();
    const pace = createPacer(clock);
    const starts = [];

    await pace(async () => {
      starts.push(clock.now());
      clock.advance(2000);
    });
    await pace(async () => starts.push(clock.now()));

    expect(starts).toEqual([0, 2000]);
  });

  it('starts the very first call immediately', async () => {
    const clock = virtualClock();
    clock.set(5_000_000);
    const pace = createPacer(clock);

    let at = null;
    await pace(async () => {
      at = clock.now();
    });

    expect(at).toBe(5_000_000);
  });

  it('returns what the task returned', async () => {
    const pace = createPacer(virtualClock());
    await expect(pace(async () => 42)).resolves.toBe(42);
  });

  it('rejects to the caller that queued the failing task', async () => {
    const pace = createPacer(virtualClock());
    await expect(pace(async () => {
      throw new Error('upstream fell over');
    })).rejects.toThrow('upstream fell over');
  });

  it('keeps running after a task throws, rather than wedging the queue', async () => {
    // A single 500 from Clubworx mid-run must not strand every remaining
    // student behind a rejected promise in the chain.
    const clock = virtualClock();
    const pace = createPacer(clock);

    const failed = pace(async () => {
      throw new Error('boom');
    });
    const after = pace(async () => 'still here');

    await expect(failed).rejects.toThrow('boom');
    await expect(after).resolves.toBe('still here');
  });

  it('paces the call after a failure too', async () => {
    const clock = virtualClock();
    const pace = createPacer(clock);

    await pace(async () => {
      throw new Error('boom');
    }).catch(() => {});
    const at = await pace(async () => clock.now());

    expect(at).toBe(800);
  });

  it('counts the calls it has let through', async () => {
    const pace = createPacer(virtualClock());
    await pace(async () => null);
    await pace(async () => null);

    expect(pace.calls).toBe(2);
  });

  it('accepts a slower interval but never a faster one than the measured ceiling', () => {
    // 120/min did not run clean (#51). A caller asking for a tighter pace is
    // asking for the failure that was already measured, so it is refused here
    // rather than discovered in production.
    expect(() => createPacer({ ...virtualClock(), minIntervalMs: 400 })).toThrow(/slower/i);
    expect(() => createPacer({ ...virtualClock(), minIntervalMs: 2000 })).not.toThrow();
  });
});
