#!/usr/bin/env node
/**
 * staff-site#97 — does `GET /api/v2/events/:id` resolve a single event?
 *
 *   node probes/run-97.mjs [--dry-run] [--missing-id=<id>] [--dev-vars=<path>]
 *
 * Read-only throughout, and read-only *by construction*: the only module here
 * that reaches Clubworx is `lib/http.mjs`, which issues GET and nothing else.
 * There is no import of `lib/write.mjs`, `lib/booking.mjs` or
 * `lib/membership.mjs`, so this script cannot create, book or cancel anything
 * even if it were asked to.
 *
 * ---------------------------------------------------------------------------
 * The question
 * ---------------------------------------------------------------------------
 * #67 shipped `resolveEvent` — the paste-the-event-id fallback behind
 * `GET /api/clubworx/events?event_id=` — against an endpoint **nobody has ever
 * called**. Every probe on this map so far has read the `/events` collection.
 * Path addressing does exist in this API (`DELETE /bookings/:id`, measured in
 * #60), which is the whole reason `events/:id` was the guess; #50 is the
 * standing reminder of what a guess costs here.
 *
 * Four reads answer it:
 *
 *   1. `GET /events` over a window, to obtain a real future event id.
 *   2. `GET /events/<that id>` inside the same window — status and *shape*.
 *   3. `GET /events/<an id that does not exist>` — does the route discriminate,
 *      or would a paste field confirm anything typed into it?
 *   4. `GET /events/<the real id>` with no date window — does the window
 *      requirement (#51) follow the collection to the addressed form?
 *
 * The cheapest probe on this map: 4 reads against a 75/minute gym-wide
 * allowance (#51).
 *
 * ---------------------------------------------------------------------------
 * What may be written down
 * ---------------------------------------------------------------------------
 * Ids, field **names**, statuses and timings. Never `event_name`, never
 * `instructor_name`, never a row — `probes/README.md`. staff-site is a public
 * repo, and `describeEventById` is where that reduction happens so it is one
 * rule rather than a habit.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGetter } from './lib/http.mjs';
import { loadAccountKey } from './lib/key.mjs';
import { describeEventById, summariseEvents } from './lib/report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, 'out');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

/**
 * An id that should not exist, for call 3.
 *
 * Numeric on purpose. A non-numeric id would test whether Clubworx can *parse*
 * an id, which is a different question — this one asks what a well-formed id
 * with nothing behind it answers. The key is scoped to one gym, so a number
 * this far above UJ's range belongs to no event the key can see either way.
 */
const MISSING_ID = args.find(a => a.startsWith('--missing-id='))?.split('=')[1] ?? '999999999';

/** Points at a key outside the package — a git worktree, where .dev.vars is
 * gitignored and so does not follow the checkout. */
const DEV_VARS =
  args.find(a => a.startsWith('--dev-vars='))?.split('=').slice(1).join('=') ||
  path.join(HERE, '..', '.dev.vars');

/** Clubworx dates are plain YYYY-MM-DD; the gym runs on Australia/Perth. */
const perthDate = offsetDays => {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Perth' }).format(d);
};

const line = (label, value) => console.log(`  ${label.padEnd(34)} ${value}`);

/** Ids only. The window is deliberately short — one page is all this needs. */
async function findRealEventId(get, window) {
  const res = await get('events', { ...window, page_size: 50 });
  const events = summariseEvents(res.body);

  line('listing for a real id', `HTTP ${res.status} · ${res.ms}ms · ${events.count} events`);

  // The *first* future event, not any event: an id from the past is still a
  // valid address, but a route that only ever resolved historical rows would
  // answer a question #54 is not asking.
  const rows = Array.isArray(res.body) ? res.body : [];
  const now = new Date().toISOString();
  const future = rows
    .filter(r => r?.event_id !== null && r?.event_id !== undefined && r?.event_start_at > now)
    .sort((a, b) => String(a.event_start_at).localeCompare(String(b.event_start_at)));

  return {
    id: future[0]?.event_id ?? null,
    startsAt: future[0]?.event_start_at ?? null,
    listing: { status: res.status, ms: res.ms, count: events.count, fields: events.fields },
    collectionIds: events.ids,
  };
}

async function main() {
  const window = { event_starts_after: perthDate(-1), event_ends_before: perthDate(60) };

  if (DRY_RUN) {
    // The key is loaded *after* this branch, so a dry run works on a machine
    // that has not been given one — which is the machine most likely to be
    // reading the plan before deciding to run it.
    console.log('--dry-run: no requests issued. This run would make 4 reads, all GET:');
    console.log(`  1. GET /events?event_starts_after=${window.event_starts_after}` +
      `&event_ends_before=${window.event_ends_before}&page_size=50`);
    console.log('  2. GET /events/<the first future id from 1>  (same window)');
    console.log(`  3. GET /events/${MISSING_ID}                 (same window)`);
    console.log('  4. GET /events/<the same real id>            (no window at all)');
    console.log('  Nothing is created, updated or deleted.');
    return;
  }

  const accountKey = loadAccountKey(DEV_VARS);
  const get = createGetter({ accountKey });

  console.log('staff-site#97 probe — READ ONLY, against production Clubworx');
  console.log(`  window ${window.event_starts_after} → ${window.event_ends_before}\n`);

  const seed = await findRealEventId(get, window);
  if (seed.id === null) {
    // Not a failure of the endpoint under test, and it must not be written up as
    // one: with no real id there is nothing to address.
    console.log('\nNo future event in the window — nothing to address. Widen the window and re-run.');
    return;
  }
  line('real event id', `${seed.id} (starts ${seed.startsAt})`);

  console.log('\n── The three addressed calls ─────────────────────────────────');

  const direct = await get(`events/${encodeURIComponent(seed.id)}`, window);
  line('2. events/<real id> + window', `HTTP ${direct.status} · ${direct.ms}ms`);

  const missing = await get(`events/${encodeURIComponent(MISSING_ID)}`, window);
  line(`3. events/${MISSING_ID}`, `HTTP ${missing.status} · ${missing.ms}ms`);

  const windowless = await get(`events/${encodeURIComponent(seed.id)}`);
  line('4. events/<real id>, no window', `HTTP ${windowless.status} · ${windowless.ms}ms`);

  const finding = describeEventById({
    wantedId: seed.id,
    direct,
    missing,
    windowless,
    collectionIds: seed.collectionIds,
  });

  console.log('\n── The answer ────────────────────────────────────────────────');
  line('verdict', finding.summary);
  line('events/:id is a route', String(finding.isRoute));
  line('#67 resolveEvent survives it', String(finding.resolvesFallback));
  line('fields returned', finding.fields.length ? finding.fields.join(', ') : '(none)');
  line('rows returned', String(finding.returnedIds.length));
  line('answered with the collection', String(finding.echoesCollection));
  line('a made-up id answers', `${finding.missingBehaviour} (HTTP ${finding.missingStatus})`);
  line('tells real from made-up', String(finding.discriminates));
  line('date window required', `${finding.windowRequired} (HTTP ${finding.windowlessStatus})`);

  const record = {
    probe: 'staff-site#97',
    ranAt: new Date().toISOString(),
    window,
    missingIdUsed: MISSING_ID,
    seed: { id: seed.id, startsAt: seed.startsAt, listing: seed.listing },
    calls: {
      direct: { status: direct.status, ms: direct.ms, contentType: direct.contentType },
      missing: { status: missing.status, ms: missing.ms, contentType: missing.contentType },
      windowless: { status: windowless.status, ms: windowless.ms, contentType: windowless.contentType },
    },
    finding,
    totalReads: get.calls,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `97-${record.ranAt.replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(record, null, 2));

  console.log(`\n${get.calls} reads total. Summary written to probes/out/${path.basename(file)}`);
}

main().catch(err => {
  console.error(`probe failed: ${err.message}`);
  process.exitCode = 1;
});
