#!/usr/bin/env node
/**
 * staff-site#51 — event listing without a contact_key, and burst behaviour.
 *
 *   node probes/run-51.mjs [--dry-run] [--max-concurrency=16]
 *
 * Read-only throughout. It creates nothing, updates nothing and deletes
 * nothing; the only verb it can issue is GET (see lib/http.mjs).
 *
 * Two questions, both from staff-site#46's map:
 *
 *   A. `GET /events` documents `contact_key` as required, which makes an
 *      "events this week" picker awkward. Does it tolerate the parameter being
 *      omitted, blank, or arbitrary — and are the events it returns gym-wide or
 *      only that contact's?
 *   B. Clubworx publishes no rate limit and (per #47) advertises no rate-limit
 *      headers. What does a realistic 30-name lookup burst actually do?
 *
 * Nothing this script records is a row of production data. Bodies are reduced
 * to counts, ids, field names and timings before they are written or printed —
 * staff-site is a public repo and Clubworx holds ~60,000 real people.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGetter } from './lib/http.mjs';
import { loadAccountKey } from './lib/key.mjs';
import {
  summariseBurst,
  summariseEvents,
  sameIds,
  deriveRateLimit,
  recommendPacing,
} from './lib/report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, 'out');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const CALIBRATE = args.includes('--calibrate');
/** Re-run the paced lookup at a chosen rate, to find where "sustainable" stops. */
const WALLS = Number(args.find(a => a.startsWith('--walls='))?.split('=')[1] ?? 0);
const PACE_PER_MIN = Number(args.find(a => a.startsWith('--pace-per-min='))?.split('=')[1] ?? 0);
const MAX_CONCURRENCY = Number(args.find(a => a.startsWith('--max-concurrency='))?.split('=')[1] ?? 16);

/** Two-letter fragments, not names. `last_name` is a partial match, so these
 * cost the same as a real surname list while putting no real name in a public
 * repo — #46's standing constraint. */
const FRAGMENTS = [
  'an', 'ar', 'be', 'br', 'ca', 'ch', 'co', 'da', 'de', 'do',
  'el', 'fe', 'fi', 'ga', 'gr', 'ha', 'he', 'ho', 'hu', 'ja',
  'jo', 'ka', 'le', 'li', 'ma', 'mc', 'mi', 'mo', 'na', 'ne',
];

const CONTACT_TYPES = ['members', 'prospects', 'non_attending_contacts'];

/** Clubworx dates are plain YYYY-MM-DD; the gym runs on Australia/Perth. */
const perthDate = offsetDays => {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Perth' }).format(d);
};

const DEV_VARS = path.join(HERE, '..', '.dev.vars');

/** Run thunks with a bounded number in flight, preserving result order. */
async function pool(thunks, concurrency) {
  const results = new Array(thunks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, thunks.length) }, async () => {
    while (next < thunks.length) {
      const i = next++;
      results[i] = await thunks[i]();
    }
  });
  await Promise.all(workers);
  return results;
}

const line = (label, value) => console.log(`  ${label.padEnd(34)} ${value}`);

async function probeEventListing(get) {
  const window = { event_starts_after: perthDate(-7), event_ends_before: perthDate(90) };

  console.log('\n── A. Event listing ──────────────────────────────────────────');
  console.log(`  window ${window.event_starts_after} → ${window.event_ends_before}\n`);

  // A real contact_key to compare against. Its owner is a real person, so the
  // key is used and then dropped: it is never printed, returned or written.
  const seed = await get('members', { page_size: 1 });
  const realContactKey = Array.isArray(seed.body) ? seed.body[0]?.contact_key : undefined;
  line('seed /members page_size=1', `HTTP ${seed.status}, real contact_key ${realContactKey ? 'obtained' : 'UNAVAILABLE'}`);

  const variants = [
    ['contact_key omitted', { ...window }],
    ['contact_key blank', { ...window, contact_key: '' }],
    ['contact_key arbitrary', { ...window, contact_key: 'zzzz-not-a-real-contact-key' }],
    ['contact_key real', realContactKey ? { ...window, contact_key: realContactKey } : null],
    ['no date window at all', { contact_key: undefined }],
  ];

  const results = {};
  for (const [label, params] of variants) {
    if (!params) {
      results[label] = { skipped: 'no real contact_key available' };
      line(label, 'skipped');
      continue;
    }
    const res = await get('events', params);
    const events = summariseEvents(res.body);
    results[label] = { status: res.status, ms: res.ms, events, headers: res.headers };
    line(
      label,
      `HTTP ${res.status} · ${res.ms}ms · ${events.count} events` +
        (events.notAnArray ? ` · body: ${String(res.bodyText ?? '').slice(0, 80)}` : ''),
    );
  }

  const omitted = results['contact_key omitted']?.events?.ids ?? [];
  const real = results['contact_key real']?.events?.ids ?? [];
  const arbitrary = results['contact_key arbitrary']?.events?.ids ?? [];

  const verdict = {
    tolerated: results['contact_key omitted']?.status === 200,
    // If an arbitrary key returns the same list as no key, the parameter is
    // being ignored — which is what makes a gym-wide picker possible.
    ignoresContactKey: sameIds(omitted, arbitrary),
    scopedToContact: real.length > 0 && !sameIds(omitted, real),
  };

  console.log('');
  line('omitted vs arbitrary key', verdict.ignoresContactKey ? 'same events → parameter ignored' : 'different events');
  line('omitted vs real key', sameIds(omitted, real) ? 'same events' : 'different events');

  // A default page holds 50. A window that returns exactly 50 is indistinguishable
  // from one that was truncated at the page boundary, and a picker that silently
  // shows the first 50 events of a term is worse than one that admits a cap.
  console.log('');
  const paging = {};
  for (const [label, params] of [
    ['events page_size=200', { ...window, page_size: 200 }],
    ['events page=2', { ...window, page: 2 }],
  ]) {
    const res = await get('events', params);
    const events = summariseEvents(res.body);
    paging[label] = { status: res.status, ms: res.ms, count: events.count, earliest: events.earliest, latest: events.latest };
    line(label, `HTTP ${res.status} · ${res.ms}ms · ${events.count} events`);
  }

  return { window, results, verdict, paging };
}

async function probePagination(get) {
  console.log('\n── C. Pagination above page_size 50 ──────────────────────────');
  const sizes = [50, 100, 200];
  const out = {};
  for (const size of sizes) {
    const res = await get('members', { page_size: size, page: 1 });
    const returned = Array.isArray(res.body) ? res.body.length : null;
    out[size] = { status: res.status, ms: res.ms, returned };
    line(`page_size=${size}`, `HTTP ${res.status} · ${res.ms}ms · ${returned} rows returned`);
  }
  return out;
}

async function probeBurst(get) {
  console.log('\n── B. Burst behaviour ────────────────────────────────────────');
  console.log(`  ${FRAGMENTS.length} name fragments × ${CONTACT_TYPES.length} contact types = ` +
    `${FRAGMENTS.length * CONTACT_TYPES.length} reads per level\n`);

  const levels = [4, 8, 16].filter(n => n <= MAX_CONCURRENCY);
  const out = {};

  for (const concurrency of levels) {
    const thunks = FRAGMENTS.flatMap(fragment =>
      CONTACT_TYPES.map(type => () => get(type, { last_name: fragment, page_size: 50 })),
    );

    const started = Date.now();
    const samples = await pool(thunks, concurrency);
    const wallMs = Date.now() - started;

    const summary = summariseBurst(samples.map(s => ({ status: s.status, ms: s.ms, error: s.error })));
    const headersSeen = Object.assign({}, ...samples.map(s => s.headers));

    out[concurrency] = { ...summary, wallMs, headersSeen };
    line(
      `concurrency ${concurrency}`,
      `${summary.count} reads in ${wallMs}ms · ${JSON.stringify(summary.byStatus)}` +
        ` · p50 ${summary.ms.p50}ms p95 ${summary.ms.p95}ms max ${summary.ms.max}ms` +
        ` · ${summary.clean ? 'CLEAN' : 'NOT CLEAN'}`,
    );
    if (Object.keys(headersSeen).length) line('  rate-limit headers seen', JSON.stringify(headersSeen));

    // Escalating past a level that already failed would only add load to a
    // production API that has just told us it is unhappy.
    if (!summary.clean) {
      console.log('  stopping escalation: this level was not clean');
      break;
    }
  }

  return out;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** The cheapest read in the API — five rows — used only to ask "am I allowed yet?". */
const CHEAPEST_READ = 'locations';

/**
 * Poll until a request succeeds, and report when that was.
 *
 * The polls themselves cost quota. If a throttled request also counts against
 * the allowance this will not recover, which is a finding rather than a bug —
 * hence the cap and the returned poll count.
 */
async function waitUntilRested(get, { pollMs = 5_000, maxMs = 300_000, label = 'resting' } = {}) {
  const started = Date.now();
  let polls = 0;
  for (;;) {
    polls += 1;
    const res = await get(CHEAPEST_READ, { page_size: 1 });
    if (res.status === 200) {
      const waitedMs = Date.now() - started;
      line(label, `clear after ${(waitedMs / 1000).toFixed(0)}s (${polls} polls)`);
      return { waitedMs, polls, clearedAt: Date.now(), recovered: true };
    }
    if (Date.now() - started > maxMs) {
      line(label, `NOT clear after ${(maxMs / 1000).toFixed(0)}s (${polls} polls) — giving up`);
      return { waitedMs: Date.now() - started, polls, clearedAt: null, recovered: false };
    }
    await sleep(pollMs);
  }
}

/**
 * Spend the allowance serially and record exactly where the wall is.
 *
 * Serial on purpose: concurrency makes the count before the first 429 depend on
 * how many requests were already in flight when the ceiling was crossed, which
 * blurs the number this whole calibration rests on.
 */
async function fireUntilThrottled(get, { max = 150 } = {}) {
  const startedAt = Date.now();
  let allowed = 0;
  for (let i = 0; i < max; i += 1) {
    const res = await get(CHEAPEST_READ, { page_size: 1 });
    if (res.status === 429) {
      return { allowed, wallAt: Date.now(), elapsedMs: Date.now() - startedAt, startedAt, hitWall: true };
    }
    if (res.status !== 200) {
      return { allowed, wallAt: null, elapsedMs: Date.now() - startedAt, startedAt, hitWall: false, unexpected: res.status };
    }
    allowed += 1;
  }
  return { allowed, wallAt: null, elapsedMs: Date.now() - startedAt, startedAt, hitWall: false };
}

/**
 * Find the ceiling, then prove a pace that stays under it.
 *
 * The first burst showed 429s arriving mid-run with no warning and no headers,
 * so what the design actually needs is not "a concurrency that survives" but a
 * request rate. This measures the quota, the window it resets over, and then
 * runs a full 30-name lookup at the recommended pace to see it through clean.
 */
async function probeLimits(get) {
  console.log('\n── D. Where the ceiling is ───────────────────────────────────');

  const rested = await waitUntilRested(get, { label: 'waiting for a rested state' });
  if (!rested.recovered) return { rested, note: 'never reached a rested state' };

  const wall = await fireUntilThrottled(get);
  line(
    'serial reads before first 429',
    wall.hitWall
      ? `${wall.allowed} accepted in ${(wall.elapsedMs / 1000).toFixed(1)}s, then throttled`
      : `${wall.allowed} accepted, no 429 seen (status ${wall.unexpected ?? 'n/a'})`,
  );
  if (!wall.hitWall) return { rested, wall, note: 'no ceiling reached' };

  const recovery = await waitUntilRested(get, { label: 'waiting for the throttle to lift' });
  if (!recovery.recovered) return { rested, wall, recovery, note: 'throttle never lifted within the cap' };

  // The window is measured from the first request of the burst, not from the
  // 429: a rolling quota clears when the oldest request in it ages out.
  const windowMs = recovery.clearedAt - wall.startedAt;
  const limit = deriveRateLimit({ allowed: wall.allowed, windowMs });
  const pacing = recommendPacing({ allowed: wall.allowed, windowMs, reads: FRAGMENTS.length * CONTACT_TYPES.length });

  line('window (first request → clear)', `${(windowMs / 1000).toFixed(0)}s`);
  line('derived ceiling', `~${limit.perMinute} requests/min`);
  line('recommended pace', `${pacing.perMinute}/min — 1 in flight, ${pacing.gapMs}ms apart`);
  line('a 90-read lookup would take', `~${Math.round(pacing.estimatedMsFor / 1000)}s`);

  return { rested, wall, recovery, windowMs, limit, pacing };
}

/** Run the same 90-read lookup at the recommended pace and see it through. */
async function verifyPace(get, pacing) {
  console.log('\n── E. Does the recommended pace hold? ────────────────────────');

  const rested = await waitUntilRested(get, { label: 'waiting for a rested state' });
  if (!rested.recovered) return { skipped: 'never reached a rested state' };

  const samples = [];
  const started = Date.now();
  for (const fragment of FRAGMENTS) {
    for (const type of CONTACT_TYPES) {
      const res = await get(type, { last_name: fragment, page_size: 50 });
      samples.push({ status: res.status, ms: res.ms, error: res.error });
      // Gap measured from the end of the previous request: the request's own
      // latency is part of the spacing, so subtracting it would overshoot.
      await sleep(Math.max(0, pacing.gapMs - res.ms));
    }
  }

  const summary = summariseBurst(samples);
  const wallMs = Date.now() - started;
  line(
    `paced ${pacing.perMinute}/min`,
    `${summary.count} reads in ${(wallMs / 1000).toFixed(0)}s · ${JSON.stringify(summary.byStatus)} · ${summary.clean ? 'CLEAN' : 'NOT CLEAN'}`,
  );

  return { ...summary, wallMs, pacing };
}

async function main() {
  const accountKey = loadAccountKey(DEV_VARS);
  const get = createGetter({ accountKey });

  if (DRY_RUN) {
    console.log('--dry-run: no requests issued. This run would make:');
    console.log(`  A. event listing      5 reads`);
    console.log(`  C. pagination         3 reads`);
    console.log(`  B. burst              up to ${[4, 8, 16].filter(n => n <= MAX_CONCURRENCY).length} × ${FRAGMENTS.length * CONTACT_TYPES.length} reads`);
    console.log('  All GET. Nothing is created, updated or deleted.');
    return;
  }

  console.log('staff-site#51 probe — READ ONLY, against production Clubworx');

  const record = {
    probe: 'staff-site#51',
    ranAt: new Date().toISOString(),
  };

  if (WALLS) {
    // The ceiling is the load-bearing finding, and one measurement of it is an
    // anecdote. This repeats rest → spend → wall, so the write-up can quote a
    // spread rather than a single number.
    console.log('\n── D2. Where the ceiling is, repeated ────────────────────────');
    record.walls = [];
    for (let i = 0; i < WALLS; i += 1) {
      const rested = await waitUntilRested(get, { label: `run ${i + 1}: resting` });
      if (!rested.recovered) break;
      const wall = await fireUntilThrottled(get);
      record.walls.push({ ...wall, restedAfterMs: rested.waitedMs });
      line(
        `run ${i + 1}: accepted before 429`,
        `${wall.allowed} in ${(wall.elapsedMs / 1000).toFixed(1)}s` +
          ` (${(wall.allowed / (wall.elapsedMs / 1000)).toFixed(1)}/s)`,
      );
    }
  } else if (PACE_PER_MIN) {
    record.pacedRun = await verifyPace(get, {
      perMinute: PACE_PER_MIN,
      gapMs: Math.round(60_000 / PACE_PER_MIN),
      concurrency: 1,
    });
  } else if (CALIBRATE) {
    // Slow by design: it waits out the throttle twice and then paces a full
    // lookup. Split from the main run so the fast findings are not held up by
    // several minutes of deliberate idling.
    record.limits = await probeLimits(get);
    if (record.limits.pacing) record.pacedRun = await verifyPace(get, record.limits.pacing);
  } else {
    record.events = await probeEventListing(get);
    record.pagination = await probePagination(get);
    record.burst = await probeBurst(get);
  }

  record.totalReads = get.calls;

  mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `51${CALIBRATE ? '-calibrate' : ''}-${record.ranAt.replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(record, null, 2));

  console.log(`\n${get.calls} reads total. Summary written to probes/out/${path.basename(file)}`);
}

main().catch(err => {
  console.error(`probe failed: ${err.message}`);
  process.exitCode = 1;
});
