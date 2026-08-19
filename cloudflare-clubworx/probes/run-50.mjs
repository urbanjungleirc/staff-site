#!/usr/bin/env node
/**
 * staff-site#50 — can a membership-less prospect be booked into an event?
 *
 *   node probes/run-50.mjs --dry-run           # the plan and every request, zero network
 *   node probes/run-50.mjs                     # read-only: find the contacts, list bookable events
 *   node probes/run-50.mjs --event=<id> --write # books, double-books, then cancels
 *   node probes/run-50.mjs --event=<id> --free-event=<id> --write
 *   node probes/run-50.mjs --dev-vars=<path>
 *
 * ⚠️ `--write` puts a real booking on a real class that staff can see, and
 * consumes one of its spaces.
 *
 * **Do not count on taking it back.** `DELETE /bookings/:id` is in the
 * reference, but #50 never demonstrated it working. What it did establish is
 * that the endpoint needs **`contact_key` as well as `account_key`**,
 * form-encoded in the body: without it the answer is `401 "Authorization
 * failed"`, which is indistinguishable from a key that may not delete — and was
 * misread as exactly that. `cancel` now sends both, taking the contact from the
 * booking record so it cannot be forgotten, but nothing has re-run it against a
 * live booking. Treat every booking as permanent until that changes.
 *
 * **The event is never chosen automatically.** `--event` is required for a
 * write, because picking one by algorithm means a booking lands on whichever
 * class happened to sort first — a real session, with real staff and real
 * customers. A read-only run lists the candidates for a human to choose from.
 *
 * Four questions, all from #46's map. The whole feature assumes the answer to
 * the first is yes, and nothing in the API reference settles it:
 *
 *   1. Does booking a membership-less prospect succeed at all?
 *   2. If not, what does it need — a membership, a plan, or an event flagged
 *      `free_class`?
 *   3. Does booking the same contact into the same event twice error, or
 *      silently create a second booking? #46's safety model assumes re-running
 *      the tool is idempotent.
 *   4. Does `DELETE /bookings/:id` cleanly reverse a booking made this way?
 *
 * This probe **creates no contacts**. ACCESS.md section 4: the three-contact
 * authorisation is spent, and #50 must reuse what #49 left behind. If those
 * contacts are missing the run stops rather than creating a fourth.
 *
 * ## The answer is per-event, and the API does not show why
 *
 * A school session at UJ is normally configured to accept a **limited number of
 * prospects** — that limit is what stops somebody booking themselves into a
 * school group by accident on the day, and allowing prospects at all is what
 * means a student needs no membership (Jiri, 2026-08-18). So questions 1 and 2
 * are not properties of the API: they are properties of *the event booked into*.
 *
 * That matters twice over.
 *
 * **`GET /events` does not expose it.** The fields are `event_id`,
 * `event_name`, `event_start_at`, `event_end_at`, `location_id`,
 * `location_name`, `free_class`, `instructor_name`, `event_full`,
 * `spaces_available` and `event_description` — verified against production on
 * 2026-08-18, and there is no prospect allowance among them. #46's picker
 * therefore **cannot pre-validate** it: a session whose prospect places are
 * exhausted looks identical to one with room, and the tool finds out only when
 * a write is rejected. Whatever this probe records, that gap is already real.
 *
 * **So `free_class` may not be the discriminator #50 guessed at.** The ticket
 * named it as the likely candidate, but a per-event prospect allowance is the
 * mechanism staff actually use. `--free-event=<id>` is therefore better read as
 * "a comparison event configured differently" than as "a free class"; what
 * separates the two answers is the configuration, not the flag's name.
 *
 * Booking a generic open-climb session would answer a *different question* to
 * the one #46 needs — which is why the event is a deliberate choice rather than
 * a default.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGetter } from './lib/http.mjs';
import { createBooker } from './lib/booking.mjs';
import { loadAccountKey } from './lib/key.mjs';
import { PROBE_CONTACTS, pickProbeRows, plusTag } from './lib/identity.mjs';
import {
  summariseContacts,
  summariseBookings,
  summariseEvents,
  classifyWrite,
  describeBookingRequirement,
  describeDuplicateBooking,
  describeCancellation,
  pickBookableEvents,
} from './lib/report.mjs';
import { errorMessageOf } from '../src/errors.js';
import { redact } from '../src/request.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, 'out');

const args = process.argv.slice(2);
const flag = name => args.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

const DRY_RUN = args.includes('--dry-run');
const WRITE = args.includes('--write');
const EVENT_ID = flag('event') ?? null;
const FREE_EVENT_ID = flag('free-event') ?? null;
const CANCEL_ID = flag('cancel') ?? null;
const DEV_VARS = flag('dev-vars') || path.join(HERE, '..', '.dev.vars');

/** The two plus-tags #49 created, derived rather than restated. */
const TAG_EMAILS = [...new Set(PROBE_CONTACTS.map(c => c.email))];

/**
 * How far ahead to look for a bookable event.
 *
 * #51: the date window is the one genuinely required parameter on `/events`
 * (no window is HTTP 422), and a full page is silent truncation — so this asks
 * for a narrow window and a page big enough to see past the default 50.
 */
const WINDOW_DAYS = 14;
const PAGE_SIZE = 200;

/** 75 requests/minute, one in flight — the ceiling measured in #51. */
const GAP_MS = 800;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const line = (label, value) => console.log(`  ${label.padEnd(38)} ${value}`);
const rule = title => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);

const isoDay = offsetDays => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};

/**
 * Find the contacts #49 left behind. This probe may not create any.
 *
 * Everything returned has passed `isProbeRow` via `pickProbeRows`, which is
 * what makes it safe to hand these keys to the booker as its allowlist — a
 * stranger who happens to share the probe address is counted and dropped.
 */
async function findProbeContacts(get) {
  rule('0. Find the contacts #49 created — this probe creates none');

  const found = [];
  let strangers = 0;

  for (const email of TAG_EMAILS) {
    const res = await get('prospects', { email });
    const rows = pickProbeRows(res.body);
    const summary = summariseContacts(
      res.body,
      rows.map(r => r.contact_key),
    );
    found.push(...rows);
    strangers += summary.strangers;

    line(
      `prospects email=+${plusTag(email)}`,
      `HTTP ${res.status} · ${summary.count} returned · ${rows.length} are ours`,
    );
    await sleep(GAP_MS);
  }

  if (strangers) line('rows returned that are not ours', `${strangers} (counted, not recorded)`);

  const byKey = new Map(found.map(row => [row.contact_key, row]));
  return [...byKey.values()];
}

/** What is bookable in the next fortnight, for a human to choose from. */
async function listEvents(get) {
  rule('1. Events — which of these could a test booking go on?');

  const res = await get('events', {
    event_starts_after: isoDay(0),
    event_ends_before: isoDay(WINDOW_DAYS),
    page_size: PAGE_SIZE,
  });
  const summary = summariseEvents(res.body);
  const bookable = pickBookableEvents(res.body);

  line('events in the window', `HTTP ${res.status} · ${summary.count} returned`);
  line('bookable (future, with spaces)', `${bookable.paid.length} paid · ${bookable.free.length} free_class`);
  if (summary.count >= PAGE_SIZE) {
    // #51: a full page is indistinguishable from a complete list by anything in
    // the response — no total, no next-page link, no header.
    line('⚠️  page came back full', 'the list is truncated — narrow the window');
  }

  return { summary, bookable, status: res.status };
}

/**
 * Cancel a booking that already exists on a probe contact.
 *
 * The cleanup path, and the one place `allowCancel` is used. A booking made by
 * hand in the Clubworx UI is not one this process created, so `cancel` will not
 * touch it until it has been **found on a probe contact** — which is why this
 * searches for it rather than taking the id on trust. An id alone would let any
 * booking through, including a real member's.
 *
 * It also answers question 4 without creating anything, when the UI has already
 * left a booking behind.
 */
async function cancelExisting(get, booker, { contacts, bookingId, accountKey }) {
  rule(`Cancel booking ${bookingId} (Q4)`);

  const reasonOf = sample => {
    const message = errorMessageOf(sample?.body);
    return message ? redact(message, accountKey) : null;
  };

  for (const contact of contacts) {
    const held = await countBookings(get, contact.contact_key);
    const found = held.ids.includes(String(bookingId));
    line(
      `${contact.last_name} holds`,
      `${held.ours} booking(s)${found ? ' — including this one' : ''}`,
    );
    await sleep(GAP_MS);

    if (!found) continue;

    // Vouched for only now that it has been seen on a contact that passed the
    // identity guard. This is the whole reason allowCancel takes a contact key.
    booker.allowCancel(bookingId, contact.contact_key);

    const res = await booker.cancel(bookingId);
    line(
      'DELETE',
      res.refused
        ? `REFUSED locally: ${res.refused}`
        : res.dryRun
          ? 'would DELETE — pass --write to do it'
          : `HTTP ${res.status ?? 'n/a'}${res.error ? ` · ${res.error}` : ''}` +
            (reasonOf(res) ? ` · "${reasonOf(res)}"` : '') +
            (res.bodyText ? ` · ${res.bodyText.slice(0, 200)}` : ''),
    );
    if (!res.dryRun) await sleep(GAP_MS);

    const after = await countBookings(get, contact.contact_key);
    line('bookings held after', `HTTP ${after.status} · ${after.ours}`);

    // Judged on the re-count, never on the status: a 2xx that removed nothing
    // is a failure, and #46 plans to rely on this to undo a mistaken bulk
    // booking.
    const reversal = describeCancellation({
      cancel: res,
      countBefore: held.ours,
      countAfter: after.ours,
    });

    rule('Verdict');
    line('Q4  DELETE reverses a booking', String(reversal.reversed));
    console.log(`  ${reversal.summary}`);

    return { bookingId, contact_key: contact.contact_key, reversal, status: res.status ?? null, reason: reasonOf(res), bodyText: res.bodyText ?? null, counts: { before: held.ours, after: after.ours } };
  }

  console.log(
    `\n  Booking ${bookingId} is not held by any probe contact, so it will not be\n` +
      '  cancelled. Cancelling a real member\'s class is the worst outcome available\n' +
      '  on this map, and an id alone is not evidence of whose booking it is.',
  );
  return { bookingId, contact_key: null, reversal: null, refused: 'not held by a probe contact' };
}

/** Bookings currently held by a probe contact — the before/after count. */
async function countBookings(get, contactKey) {
  const res = await get('bookings', { contact_key: contactKey });
  const summary = summariseBookings(res.body, [contactKey]);
  return { status: res.status, ...summary };
}

/**
 * Questions 1–4, against one event.
 *
 * The counts either side of every write are what actually answer 3 and 4: a
 * silent duplicate and an idempotent server return the same status code, and so
 * do a DELETE that worked and one that only said it did.
 */
async function probeBooking(get, booker, { contactKey, eventId, label, accountKey }) {
  rule(`${label} — event ${eventId}`);

  // Why the server refused is the answer to question 2, and it exists nowhere
  // else. Redacted on the way out like every other string this probe prints.
  const reasonOf = sample => {
    const message = errorMessageOf(sample?.body);
    return message ? redact(message, accountKey) : null;
  };

  const before = await countBookings(get, contactKey);
  line('bookings held before', `HTTP ${before.status} · ${before.ours}`);
  await sleep(GAP_MS);

  const first = await booker.book({ contact_key: contactKey, event_id: eventId, label });
  const firstClass = classifyWrite(first);
  line(
    'book (Q1)',
    first.refused
      ? `REFUSED locally: ${first.refused}`
      : first.dryRun
        ? `would POST ${JSON.stringify(first.wouldSend)}`
        : `HTTP ${first.status ?? 'n/a'} ${firstClass.outcome}` +
          (first.bookingId ? ` · booking ${first.bookingId}` : '') +
          (first.error ? ` · ${first.error}` : '') +
          (reasonOf(first) ? ` · "${reasonOf(first)}"` : '') +
          (first.bodyText ? ` · ${first.bodyText.slice(0, 160)}` : ''),
  );
  if (!first.dryRun) await sleep(GAP_MS);

  const afterFirst = await countBookings(get, contactKey);
  line('bookings held after', `HTTP ${afterFirst.status} · ${afterFirst.ours}`);
  await sleep(GAP_MS);

  // Question 3 only means something if the first booking landed. Asking it
  // after a rejection would measure two rejections and call it idempotency.
  let second = null;
  let secondClass = null;
  let afterSecond = null;

  if (firstClass.outcome === 'created') {
    second = await booker.book({ contact_key: contactKey, event_id: eventId, label: `${label} again` });
    secondClass = classifyWrite(second);
    line(
      'book the same again (Q3)',
      second.refused
        ? `REFUSED locally: ${second.refused}`
        : `HTTP ${second.status ?? 'n/a'} ${secondClass.outcome}` +
          (second.bookingId ? ` · booking ${second.bookingId}` : '') +
          (reasonOf(second) ? ` · "${reasonOf(second)}"` : '') +
          (second.bodyText ? ` · ${second.bodyText.slice(0, 160)}` : ''),
    );
    await sleep(GAP_MS);

    afterSecond = await countBookings(get, contactKey);
    line('bookings held after the second', `HTTP ${afterSecond.status} · ${afterSecond.ours}`);
    await sleep(GAP_MS);
  } else if (!first.dryRun) {
    line('book the same again (Q3)', 'SKIPPED — the first booking did not land');
  }

  const duplicate = describeDuplicateBooking({
    second: secondClass,
    countBefore: afterFirst.ours,
    countAfter: afterSecond?.ours ?? null,
  });

  // Question 4: undo everything this run created, and prove it left.
  const cancellations = [];
  const ids = [first.bookingId, second?.bookingId].filter(Boolean);
  const uniqueIds = [...new Set(ids.map(String))];

  for (const id of uniqueIds) {
    const res = await booker.cancel(id);
    cancellations.push({ id, status: res.status ?? null, refused: res.refused ?? null, error: res.error ?? null });
    line(
      `cancel ${id} (Q4)`,
      res.refused
        ? `REFUSED locally: ${res.refused}`
        : res.dryRun
          ? 'would DELETE'
          : `HTTP ${res.status ?? 'n/a'}${res.error ? ` · ${res.error}` : ''}`,
    );
    if (!res.dryRun) await sleep(GAP_MS);
  }

  const afterCancel = uniqueIds.length ? await countBookings(get, contactKey) : null;
  if (afterCancel) line('bookings held after cancelling', `HTTP ${afterCancel.status} · ${afterCancel.ours}`);

  const lastCancel = cancellations[cancellations.length - 1] ?? null;
  const reversal = describeCancellation({
    cancel: lastCancel,
    countBefore: afterSecond?.ours ?? afterFirst.ours,
    countAfter: afterCancel?.ours ?? null,
  });

  return {
    eventId,
    outcome: firstClass,
    first: {
      status: first.status ?? null,
      bookingId: first.bookingId ?? null,
      refused: first.refused ?? null,
      error: first.error ?? null,
      // The server's own words. Without this a rejection is just "HTTP 400",
      // and question 2 has nothing to work from.
      reason: reasonOf(first),
      bodyText: first.bodyText ?? null,
      fields: first.body && !Array.isArray(first.body) ? Object.keys(first.body) : [],
    },
    secondReason: second ? reasonOf(second) : null,
    second: secondClass,
    counts: {
      before: before.ours,
      afterFirst: afterFirst.ours,
      afterSecond: afterSecond?.ours ?? null,
      afterCancel: afterCancel?.ours ?? null,
    },
    duplicate,
    cancellations,
    reversal,
    // Anything still standing when the run ends is somebody's job to remove.
    leftBehind: (afterCancel?.ours ?? 0) > before.ours,
  };
}

function printDryRun() {
  console.log('--dry-run: no requests issued, nothing booked.\n');

  let n = 0;
  const req = (verb, p, params) =>
    console.log(`  ${String(++n).padStart(2)}. ${verb.padEnd(6)} /${p}${params ? `?${params}` : ''}`);

  console.log('0. Find #49\'s contacts — this probe creates none:');
  for (const email of TAG_EMAILS) req('GET', 'prospects', `email=${email}`);

  console.log('\n1. Events in the next fortnight:');
  req('GET', 'events', `event_starts_after=${isoDay(0)}&event_ends_before=${isoDay(WINDOW_DAYS)}&page_size=${PAGE_SIZE}`);

  const plan = [['2. Paid event (Q1, Q3, Q4)', EVENT_ID], ['3. free_class event (Q2)', FREE_EVENT_ID]].filter(
    ([, id]) => id,
  );

  if (!plan.length) {
    console.log(
      '\n2. Booking — NOTHING PLANNED.\n' +
        '   No --event=<id> was given, so there is no booking to describe. Run\n' +
        '   read-only first: it lists the events that could take a test booking,\n' +
        '   and a human picks one. The event is never chosen automatically.',
    );
  }

  for (const [title, id] of plan) {
    console.log(`\n${title} — event ${id}:`);
    req('GET', 'bookings', 'contact_key=<probe contact>');
    req('POST', 'bookings');
    console.log('        { contact_key: <probe contact>, event_id: ' + id + ' }');
    req('GET', 'bookings', 'contact_key=<probe contact>');
    req('POST', 'bookings');
    console.log('        the same again — does it duplicate? (Q3)');
    req('GET', 'bookings', 'contact_key=<probe contact>');
    req('DELETE', `bookings/<id created above>`);
    req('GET', 'bookings', 'contact_key=<probe contact>');
  }

  console.log(
    `\n${n} requests, paced at one per ${GAP_MS}ms (~${Math.round(60_000 / GAP_MS)}/min), per #51.`,
  );
  console.log(
    '⚠️  Treat a booking this run creates as permanent. It attempts a cancel, but\n' +
      '    DELETE /bookings/:id has never been demonstrated to work here (#50) — so\n' +
      '    assume anything booked below is cleared by hand in the Clubworx UI.\n' +
      'Contacts are reused from #49 and never created — ACCESS.md §4, the\n' +
      'three-contact authorisation is spent.',
  );
}

async function main() {
  if (DRY_RUN) {
    printDryRun();
    return;
  }

  const accountKey = loadAccountKey(DEV_VARS);
  const get = createGetter({ accountKey });

  console.log(
    WRITE
      ? 'staff-site#50 probe — WRITES ENABLED, against production Clubworx'
      : 'staff-site#50 probe — read-only. It lists what could be booked; pass --event=<id> --write to book.',
  );

  const record = { probe: 'staff-site#50', ranAt: new Date().toISOString(), write: WRITE };

  const contacts = await findProbeContacts(get);
  record.contacts = contacts.map(c => ({ contact_key: c.contact_key, last_name: c.last_name }));

  if (!contacts.length) {
    // ACCESS.md §4: the three-contact authorisation is spent. Creating a fourth
    // is a new decision, not something a probe may take on its own.
    rule('Stopped');
    console.log(
      '  No probe contacts found. #50 must reuse the three #49 created, and the\n' +
        '  authorisation to create contacts is spent (ACCESS.md §4) — so this probe\n' +
        '  will not create a fourth. Run `node probes/run-49.mjs` to check what is\n' +
        '  there, and ask before creating anything.',
    );
    process.exitCode = 1;
    return;
  }

  // The cleanup path. It needs no event list, so it runs before one is fetched.
  if (CANCEL_ID) {
    const booker = createBooker({
      accountKey,
      allowedContactKeys: contacts.map(c => c.contact_key),
      live: WRITE,
    });

    record.cancelled = await cancelExisting(get, booker, {
      contacts,
      bookingId: CANCEL_ID,
      accountKey,
    });
    if (!WRITE) console.log('\n  Read-only run — nothing was cancelled. Re-run with --write.');

    mkdirSync(OUT_DIR, { recursive: true });
    const outFile = path.join(OUT_DIR, `50-cancel-${record.ranAt.replace(/[:.]/g, '-')}.json`);
    writeFileSync(outFile, JSON.stringify(record, null, 2));
    console.log(
      `\n${get.calls} reads, ${booker.cancel.writes} writes. Summary written to probes/out/${path.basename(outFile)}`,
    );
    return;
  }

  // Contact A is the baseline: a prospect with no membership and no class pass.
  const subject = contacts[0];
  line('booking as', `${subject.last_name} · ${subject.contact_key}`);
  await sleep(GAP_MS);

  const events = await listEvents(get);
  record.events = {
    status: events.status,
    count: events.summary.count,
    fields: events.summary.fields,
    bookable: { paid: events.bookable.paid.length, free: events.bookable.free.length },
  };

  const show = (title, list) => {
    console.log(`\n  ${title}`);
    if (!list.length) {
      console.log('    none in this window');
      return;
    }
    for (const e of list.slice(0, 8)) {
      console.log(
        `    event_id ${String(e.event_id).padEnd(10)} ${String(e.event_start_at).slice(0, 16)}  ` +
          `${String(e.spaces_available).padStart(3)} spaces  ${e.event_name ?? ''}`,
      );
    }
    if (list.length > 8) console.log(`    … and ${list.length - 8} more`);
  };

  if (!WRITE) {
    show('Paid events that could take a test booking:', events.bookable.paid);
    show('free_class events (needed for Q2):', events.bookable.free);
    console.log(
      '\n  Read-only run — nothing was booked. Pick an event above and re-run:\n' +
        '    node probes/run-50.mjs --event=<id> --write\n' +
        '  Add --free-event=<id> to answer Q2 if the paid booking is rejected.',
    );
    record.candidates = events.bookable;
  }

  // Which event was booked is part of the finding, not run metadata: the answer
  // is a property of the event's configuration, so a verdict recorded without
  // the event beside it cannot be read later. `null` when the id is outside the
  // listed window — a purpose-made test event may well be, and the probe still
  // books it by id.
  const describeTarget = id =>
    [...events.bookable.paid, ...events.bookable.free].find(
      e => String(e.event_id) === String(id),
    ) ?? null;

  record.targets = {
    paid: EVENT_ID ? { event_id: EVENT_ID, ...(describeTarget(EVENT_ID) ?? {}) } : null,
    free: FREE_EVENT_ID ? { event_id: FREE_EVENT_ID, ...(describeTarget(FREE_EVENT_ID) ?? {}) } : null,
  };

  const booker = createBooker({
    accountKey,
    allowedContactKeys: contacts.map(c => c.contact_key),
    live: WRITE,
  });

  if (WRITE && !EVENT_ID) {
    rule('Stopped');
    console.log(
      '  --write needs --event=<id>. The event is never chosen automatically:\n' +
        '  a booking lands on a real class that staff see, and picking one by\n' +
        '  sort order means picking somebody\'s actual session. Run without\n' +
        '  --write to list the candidates.',
    );
    process.exitCode = 1;
    return;
  }

  if (EVENT_ID) {
    record.paid = await probeBooking(get, booker, {
      contactKey: subject.contact_key,
      eventId: EVENT_ID,
      label: '2. Paid event (Q1, Q3, Q4)',
      accountKey,
    });
  }

  // Question 2 only needs asking if question 1 failed. Booking a second event
  // after a success is a booking nobody needed.
  const paidRejected = record.paid?.outcome?.outcome === 'rejected';

  if (FREE_EVENT_ID && paidRejected) {
    record.free = await probeBooking(get, booker, {
      contactKey: subject.contact_key,
      eventId: FREE_EVENT_ID,
      label: '3. free_class event (Q2)',
      accountKey,
    });
  } else if (FREE_EVENT_ID) {
    rule('3. free_class event (Q2) — SKIPPED');
    console.log('  The paid booking was not rejected, so there is nothing for free_class to explain.');
  } else if (paidRejected) {
    rule('3. free_class event (Q2) — NOT ASKED');
    console.log(
      '  The paid booking was rejected and no --free-event=<id> was given, so\n' +
        '  what a booking requires is UNANSWERED. Re-run with --free-event to tell\n' +
        '  "free classes only" from "an entitlement is required" — they change the\n' +
        '  tool in very different ways.',
    );
  }

  if (EVENT_ID) {
    const requirement = describeBookingRequirement({
      paid: record.paid?.outcome ?? null,
      free: record.free?.outcome ?? null,
    });
    record.verdicts = {
      requirement,
      duplicate: record.paid?.duplicate ?? null,
      reversal: record.paid?.reversal ?? null,
    };

    rule('Verdicts');
    line('Q1  membership-less prospect books', String(record.paid?.outcome?.outcome ?? 'not attempted'));
    if (record.paid?.first?.reason) line('    the server said', `"${record.paid.first.reason}"`);
    line('Q2  what it requires', requirement.requirement ?? 'inconclusive');
    line('Q3  double-booking', record.paid?.duplicate?.summary ?? 'not asked');
    line('Q4  DELETE reverses it', record.paid?.reversal?.summary ?? 'not asked');

    if (requirement.entitlementNeeded) {
      // #50: "Flag that loudly rather than absorbing it."
      console.log(
        `\n  ⚠️  ${requirement.summary}.\n` +
          '      #46\'s tool would have to assign a membership plan as well as create a\n' +
          '      contact — a new decision about cost, plan choice, and what that does to\n' +
          '      Clubworx reporting. This is not a detail to absorb into the design.',
      );
    }

    if (record.paid?.duplicate?.duplicated) {
      console.log(
        '\n  ⚠️  Booking the same contact into the same event twice creates TWO bookings.\n' +
          '      Re-running the tool against an event double-books every student, so it\n' +
          '      must check existing bookings before writing — the safety model assumed\n' +
          '      the server would refuse.',
      );
    }

    const stranded = [record.paid, record.free].filter(r => r?.leftBehind);
    if (stranded.length) {
      rule('⚠️  Cleanup — bookings this run could not undo');
      for (const r of stranded) {
        console.log(
          `  event ${r.eventId}: ${r.counts.afterCancel} booking(s) still held by ` +
            `${subject.last_name} (${subject.contact_key}).\n` +
            '  Remove them in the Clubworx UI.',
        );
      }
    }
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `50-${record.ranAt.replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(record, null, 2));

  const writes = booker.book.writes + booker.cancel.writes;
  console.log(
    `\n${get.calls} reads, ${writes} writes. Summary written to probes/out/${path.basename(file)}`,
  );
}

main().catch(err => {
  console.error(`probe failed: ${err.message}`);
  process.exitCode = 1;
});
