#!/usr/bin/env node
/**
 * staff-site#60 — does the member + School Pass route actually book?
 *
 *   node probes/run-60.mjs --dry-run              # the plan and every request, zero network
 *   node probes/run-60.mjs                        # read-only: contacts, plan, memberships, event
 *   node probes/run-60.mjs --event=<id> --write   # assigns a pass if missing, then books
 *   node probes/run-60.mjs --dev-vars=<path>
 *
 * #50 proved the prospect route does not work: Clubworx applies a per-contact
 * prospect allowance the API cannot pass and does not report honestly. The
 * replacement — student as **member**, holding a **School Pass**, booked into a
 * **School Session** — was a proposal with nothing behind it. This probe is what
 * puts something behind it, before #52–#55 design against it.
 *
 * ⚠️ Two irreversible writes live here, and they are not equally reversible:
 *
 *   - **Assigning a School Pass is permanent.** The reference exposes list and
 *     create for memberships and *no delete*. A pass on the wrong contact is a
 *     lasting mark on a real person's record.
 *   - **A booking may or may not be.** `DELETE /bookings/:id` is documented but
 *     has never been demonstrated here — #50 tried, sent it malformed, and read
 *     the resulting 401 as a permissions wall. Question 7 settles that.
 *
 * Both are searched for first, so a re-run costs nothing permanent.
 *
 * The questions, from #60:
 *
 *   1. Does `POST /memberships` work as documented, and is the pass active at once?
 *   2. Can the plan be resolved by *name*? (It could not be, with default paging —
 *      see `resolvePlan`.)
 *   3. Does a member holding an active School Pass book into a School Session?
 *   4. Does `spaces_available` predict bookability now, where it did not in #50?
 *   5. What does the 1-day-ahead rule return?
 *   6. Does booking the same member into the same event twice duplicate?
 *   7. Does `DELETE /bookings/:id` reverse a booking, when sent correctly?
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGetter } from './lib/http.mjs';
import { createBooker } from './lib/booking.mjs';
import { createMembershipAssigner } from './lib/membership.mjs';
import { loadAccountKey } from './lib/key.mjs';
import { PROBE_CONTACTS, pickProbeRows, plusTag } from './lib/identity.mjs';
import { redact } from '../src/request.js';
import { errorMessageOf } from '../src/errors.js';
import {
  summariseContacts,
  summariseBookings,
  summariseEvents,
  classifyWrite,
  describeDuplicateBooking,
  describeCancellation,
  findPlanByName,
  describeLeadTime,
} from './lib/report.mjs';
import { summariseMemberships } from '../src/memberships.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, 'out');

const args = process.argv.slice(2);
const flag = name => args.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

const DRY_RUN = args.includes('--dry-run');
const WRITE = args.includes('--write');
const EVENT_ID = flag('event') ?? null;
const PLAN_NAME = flag('plan') ?? 'School Pass';
const DEV_VARS = flag('dev-vars') || path.join(HERE, '..', '.dev.vars');

/**
 * The three disjoint status views. #49: a contact appears in exactly one of
 * them, and moves when their status changes — so a probe that searches only
 * `/prospects` stops finding its own contacts the moment somebody converts
 * them, which is exactly what happened here on 2026-08-18.
 */
const CONTACT_TYPES = ['prospects', 'members', 'non_attending_contacts'];

const TAG_EMAILS = [...new Set(PROBE_CONTACTS.map(c => c.email))];

/** Big enough to see past the default 50, which silently hid this plan (#51). */
const PAGE_SIZE = 200;
const WINDOW_DAYS = 21;

const GAP_MS = 800;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const line = (label, value) => console.log(`  ${label.padEnd(38)} ${value}`);
const rule = title => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);

const isoDay = offsetDays => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};

/** Find the probe's contacts wherever their status has put them. */
async function findProbeContacts(get) {
  rule('0. Find the probe contacts — this probe creates none');

  const found = [];
  for (const type of CONTACT_TYPES) {
    let hereCount = 0;
    for (const email of TAG_EMAILS) {
      const res = await get(type, { email });
      const rows = pickProbeRows(res.body);
      const summary = summariseContacts(res.body, rows.map(r => r.contact_key));
      hereCount += rows.length;
      found.push(...rows.map(r => ({ ...r, status_endpoint: type })));
      if (summary.strangers) {
        line(`${type} +${plusTag(email)}`, `${summary.strangers} row(s) not ours (counted, dropped)`);
      }
      await sleep(GAP_MS);
    }
    line(type, hereCount ? `${hereCount} of ours` : 'none');
  }

  const byKey = new Map(found.map(row => [row.contact_key, row]));
  return [...byKey.values()];
}

/**
 * Turn the plan *name* into an id — and refuse to guess.
 *
 * A hard-coded id is a number nobody can check against the Clubworx UI, so the
 * tool will look it up by name. On 2026-08-18 the default page returned exactly
 * 50 plans out of 57, and `School Pass` was among the seven that never arrived —
 * the same silent truncation #51 found on `/events`, and a "plan not found" that
 * would have been entirely wrong.
 */
async function resolvePlan(get) {
  rule(`1–2. Resolve the membership plan by name — "${PLAN_NAME}"`);

  const res = await get('membership_plans', { page_size: PAGE_SIZE });
  const found = findPlanByName(res.body, PLAN_NAME, { requestedPageSize: PAGE_SIZE });

  line('plans returned', `HTTP ${res.status} · ${found.count}`);

  if (found.truncated) {
    line('⚠️  page came back full', `${found.count} = page_size — the list is truncated`);
  }
  if (found.ambiguous) {
    line('⚠️  ambiguous', `${found.matches} plans named "${PLAN_NAME}" — refusing to pick one`);
  }
  if (found.plan) {
    line('resolved', `id ${found.plan.id} · duration ${found.plan.membership_duration ?? 'n/a'}`);
    line('cost', `upfront ${found.plan.upfront_payment_amount ?? 'n/a'} · recurring ${found.plan.recurring_payment_amount ?? 'none'}`);
  } else {
    line('resolved', 'NOT FOUND');
  }

  return { ...found, status: res.status };
}

/** Question 1: does the contact hold an active pass, and assign one if not. */
async function ensureMembership(get, assigner, { contact, plan, live, accountKey }) {
  rule('1. School Pass — does the contact hold one?');

  const before = await get('memberships', { contact_key: contact.contact_key });
  const held = summariseMemberships(before.body, plan.id);
  line('memberships held', `HTTP ${before.status} · ${held.count} · holds this plan: ${held.holdsPlan} (active ${held.holdsActivePlan})`);
  if (held.planStates.length) {
    for (const s of held.planStates) {
      line('  state', `start ${s.start_date ?? 'n/a'} · expires ${s.expiration_date ?? 'n/a'} · active ${s.active} · ${s.class_access ?? 'n/a'}`);
    }
  }
  line('fields returned', held.fields.join(', ') || '(none)');
  await sleep(GAP_MS);

  // Search-first is not a courtesy here: memberships have no delete, so a
  // re-run that skipped this check would pile up permanent duplicates.
  // Reuse an *active* pass. An expired one is still a held plan, and treating
  // that as good enough would leave the booking to fail for a reason the probe
  // had already seen and ignored.
  if (held.holdsActivePlan) {
    line('assign', 'SKIPPED — an active pass is already held, nothing permanent to add');
    return { assigned: null, before: held, after: held, reused: true };
  }

  const res = await assigner.assign({
    contact_key: contact.contact_key,
    membership_plan_id: plan.id,
    start_date: isoDay(0),
  });
  const outcome = classifyWrite(res);
  // Was passing a NUL byte where the secret belongs: it satisfies redact's refuse-to-no-op guard
  // while matching nothing, so the account key travelled through unredacted on
  // the one path most likely to echo it back. Found by the #63 review.
  const reason = res.body ? redact(errorMessageOf(res.body) ?? '', accountKey) : null;

  line(
    'assign',
    res.refused
      ? `REFUSED locally: ${res.refused}`
      : res.dryRun
        ? `would POST ${JSON.stringify(res.wouldSend)}`
        : `HTTP ${res.status ?? 'n/a'} ${outcome.outcome}` +
          (reason ? ` · "${reason}"` : '') +
          (res.bodyText ? ` · ${res.bodyText.slice(0, 160)}` : ''),
  );
  if (!res.dryRun) await sleep(GAP_MS);

  // Whether it is *active* is the question, not whether it was accepted.
  let after = held;
  if (live && outcome.outcome === 'created') {
    const recheck = await get('memberships', { contact_key: contact.contact_key });
    after = summariseMemberships(recheck.body, plan.id);
    line('now holds this plan', String(after.holdsPlan));
    for (const s of after.planStates) {
      line('  state', `start ${s.start_date ?? 'n/a'} · expires ${s.expiration_date ?? 'n/a'} · active ${s.active} · ${s.class_access ?? 'n/a'}`);
    }
    await sleep(GAP_MS);
  }

  return {
    assigned: { status: res.status ?? null, outcome, reason, bodyText: res.bodyText ?? null },
    before: held,
    after,
    reused: false,
  };
}

/** Questions 4 and 5: what the API says about the event before anything is written. */
async function inspectEvent(get, eventId) {
  rule('4–5. The event — capacity and lead time');

  const res = await get('events', {
    event_starts_after: isoDay(-1),
    event_ends_before: isoDay(WINDOW_DAYS),
    page_size: PAGE_SIZE,
  });
  const summary = summariseEvents(res.body);
  const row = Array.isArray(res.body)
    ? res.body.find(e => String(e.event_id) === String(eventId))
    : null;

  if (!row) {
    line('event', `${eventId} NOT in the next ${WINDOW_DAYS} days (${summary.count} events seen)`);
    return { found: false, count: summary.count };
  }

  const lead = describeLeadTime(row.event_start_at);
  line('event', `${row.event_id} · ${row.event_name}`);
  line('starts', `${row.event_start_at} (${lead.hoursAhead}h away)`);
  line('capacity', `spaces_available ${row.spaces_available} · event_full ${row.event_full}`);
  line('free_class', String(row.free_class));

  if (lead.past) {
    line('⚠️  lead time', 'this event has already started');
  } else if (lead.withinLeadTime) {
    line('⚠️  lead time', `inside ${lead.minLeadHours}h — the 1-day-ahead rule may refuse this`);
  }

  return {
    found: true,
    event_id: row.event_id,
    event_name: row.event_name,
    event_start_at: row.event_start_at,
    spaces_available: row.spaces_available,
    event_full: row.event_full,
    free_class: row.free_class,
    lead,
    count: summary.count,
  };
}

/** Questions 3, 6 and 7. */
async function probeBooking(get, booker, { contact, eventId, accountKey }) {
  rule('3, 6–7. Book, double-book, then cancel');

  const reasonOf = sample => {
    const message = errorMessageOf(sample?.body);
    return message ? redact(message, accountKey) : null;
  };
  const count = async () => {
    const res = await get('bookings', { contact_key: contact.contact_key });
    return summariseBookings(res.body, [contact.contact_key]);
  };

  const before = await count();
  line('bookings held before', String(before.ours));
  await sleep(GAP_MS);

  const first = await booker.book({ contact_key: contact.contact_key, event_id: eventId });
  const firstClass = classifyWrite(first);
  line(
    'book (Q3)',
    first.refused
      ? `REFUSED locally: ${first.refused}`
      : first.dryRun
        ? `would POST ${JSON.stringify(first.wouldSend)}`
        : `HTTP ${first.status ?? 'n/a'} ${firstClass.outcome}` +
          (first.bookingId ? ` · booking ${first.bookingId}` : '') +
          (reasonOf(first) ? ` · "${reasonOf(first)}"` : '') +
          (first.bodyText ? ` · ${first.bodyText.slice(0, 160)}` : ''),
  );
  if (first.dryRun) return { dryRun: true };
  await sleep(GAP_MS);

  const afterFirst = await count();
  line('bookings held after', String(afterFirst.ours));
  await sleep(GAP_MS);

  let second = null;
  let secondClass = null;
  let afterSecond = null;

  if (firstClass.outcome === 'created') {
    second = await booker.book({ contact_key: contact.contact_key, event_id: eventId });
    secondClass = classifyWrite(second);
    line(
      'book again (Q6)',
      `HTTP ${second.status ?? 'n/a'} ${secondClass.outcome}` +
        (second.bookingId ? ` · booking ${second.bookingId}` : '') +
        (reasonOf(second) ? ` · "${reasonOf(second)}"` : ''),
    );
    await sleep(GAP_MS);

    afterSecond = await count();
    line('bookings held after the second', String(afterSecond.ours));
    await sleep(GAP_MS);
  } else {
    line('book again (Q6)', 'SKIPPED — the first booking did not land');
  }

  const duplicate = describeDuplicateBooking({
    second: secondClass,
    countBefore: afterFirst.ours,
    countAfter: afterSecond?.ours ?? null,
  });

  // Question 7, sent correctly this time: contact_key travels in a form-encoded
  // body, which is what #50 omitted.
  const ids = [...new Set([first.bookingId, second?.bookingId].filter(Boolean).map(String))];
  const cancellations = [];

  for (const id of ids) {
    const res = await booker.cancel(id);
    cancellations.push({
      id,
      status: res.status ?? null,
      refused: res.refused ?? null,
      reason: reasonOf(res),
    });
    line(
      `cancel ${id} (Q7)`,
      res.refused
        ? `REFUSED locally: ${res.refused}`
        : `HTTP ${res.status ?? 'n/a'}` + (reasonOf(res) ? ` · "${reasonOf(res)}"` : ''),
    );
    await sleep(GAP_MS);
  }

  const afterCancel = ids.length ? await count() : null;
  if (afterCancel) line('bookings held after cancelling', String(afterCancel.ours));

  const reversal = describeCancellation({
    cancel: cancellations[cancellations.length - 1] ?? null,
    countBefore: afterSecond?.ours ?? afterFirst.ours,
    countAfter: afterCancel?.ours ?? null,
  });

  return {
    dryRun: false,
    outcome: firstClass,
    firstReason: reasonOf(first),
    first: { status: first.status ?? null, bookingId: first.bookingId ?? null },
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
    leftBehind: (afterCancel?.ours ?? 0) > before.ours,
  };
}

function printDryRun() {
  console.log('--dry-run: no requests issued, nothing written.\n');

  let n = 0;
  const req = (verb, p, params) =>
    console.log(`  ${String(++n).padStart(2)}. ${verb.padEnd(6)} /${p}${params ? `?${params}` : ''}`);

  console.log('0. Find the probe contacts — all three status views (#49):');
  for (const type of CONTACT_TYPES) for (const email of TAG_EMAILS) req('GET', type, `email=${email}`);

  console.log('\n1–2. Resolve the plan by name:');
  req('GET', 'membership_plans', `page_size=${PAGE_SIZE}`);

  console.log('\n1. School Pass — held already, or assign one:');
  req('GET', 'memberships', 'contact_key=<probe contact>');
  req('POST', 'memberships');
  console.log(`        { contact_key: <probe contact>, membership_plan_id: <"${PLAN_NAME}">, start_date: ${isoDay(0)} }`);
  console.log('        ⚠️ PERMANENT — memberships have no delete endpoint');
  req('GET', 'memberships', 'contact_key=<probe contact>');

  console.log('\n4–5. The event:');
  req('GET', 'events', `event_starts_after=${isoDay(-1)}&event_ends_before=${isoDay(WINDOW_DAYS)}&page_size=${PAGE_SIZE}`);

  if (!EVENT_ID) {
    console.log('\n3, 6–7. Booking — NOTHING PLANNED. Pass --event=<id>.');
  } else {
    console.log(`\n3, 6–7. Booking into event ${EVENT_ID}:`);
    req('GET', 'bookings', 'contact_key=<probe contact>');
    req('POST', 'bookings');
    req('GET', 'bookings', 'contact_key=<probe contact>');
    req('POST', 'bookings');
    console.log('        the same again — does it duplicate? (Q6)');
    req('GET', 'bookings', 'contact_key=<probe contact>');
    req('DELETE', 'bookings/<id created above>');
    console.log('        body: account_key=…&contact_key=…  ← what #50 omitted');
    req('GET', 'bookings', 'contact_key=<probe contact>');
  }

  console.log(`\n${n} requests, paced at one per ${GAP_MS}ms (~${Math.round(60_000 / GAP_MS)}/min), per #51.`);
  console.log(
    'Both writes are searched for first, so a re-run costs nothing permanent.\n' +
      'No contact is ever created — ACCESS.md §4, that authorisation is spent.',
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
      ? 'staff-site#60 probe — WRITES ENABLED, against production Clubworx'
      : 'staff-site#60 probe — read-only. Pass --event=<id> --write to assign a pass and book.',
  );

  const record = { probe: 'staff-site#60', ranAt: new Date().toISOString(), write: WRITE };

  const contacts = await findProbeContacts(get);
  record.contacts = contacts.map(c => ({
    contact_key: c.contact_key,
    last_name: c.last_name,
    status_endpoint: c.status_endpoint,
  }));

  if (!contacts.length) {
    rule('Stopped');
    console.log('  No probe contacts found anywhere. This probe creates none — see ACCESS.md §4.');
    process.exitCode = 1;
    return;
  }

  const subject = contacts[0];
  line('acting as', `${subject.last_name} · ${subject.status_endpoint} · ${subject.contact_key}`);
  await sleep(GAP_MS);

  const plan = await resolvePlan(get);
  record.plan = {
    name: PLAN_NAME,
    id: plan.plan?.id ?? null,
    duration: plan.plan?.membership_duration ?? null,
    matches: plan.matches,
    truncated: plan.truncated,
    count: plan.count,
  };

  if (!plan.plan) {
    rule('Stopped');
    console.log(
      `  Could not resolve "${PLAN_NAME}" to exactly one plan` +
        (plan.truncated ? ' — and the page came back full, so the list is truncated.' : '.'),
    );
    process.exitCode = 1;
    return;
  }
  await sleep(GAP_MS);

  const assigner = createMembershipAssigner({
    accountKey,
    allowedContactKeys: contacts.map(c => c.contact_key),
    live: WRITE,
  });

  record.membership = await ensureMembership(get, assigner, {
    contact: subject,
    plan: plan.plan,
    live: WRITE,
    accountKey,
  });
  await sleep(GAP_MS);

  if (EVENT_ID) {
    record.event = await inspectEvent(get, EVENT_ID);
    await sleep(GAP_MS);
  }

  const booker = createBooker({
    accountKey,
    allowedContactKeys: contacts.map(c => c.contact_key),
    live: WRITE,
  });

  if (!EVENT_ID) {
    rule('3, 6–7. Booking — SKIPPED');
    console.log('  No --event=<id> given. The event is never chosen automatically.');
  } else {
    record.booking = await probeBooking(get, booker, {
      contact: subject,
      eventId: EVENT_ID,
      accountKey,
    });
  }

  rule('Verdicts');
  line('Q2  plan resolves by name', `${plan.matches === 1} (id ${plan.plan.id})`);
  line('Q1  School Pass held', `${record.membership.after.holdsPlan} · active ${record.membership.after.holdsActivePlan}`);
  if (record.event?.found) {
    line('Q4  spaces_available', `${record.event.spaces_available} · full ${record.event.event_full}`);
    line('Q5  lead time', `${record.event.lead.hoursAhead}h ahead` + (record.event.lead.withinLeadTime ? ' — inside the 1-day rule' : ''));
  }
  if (record.booking && !record.booking.dryRun) {
    line('Q3  member with pass books', String(record.booking.outcome.outcome));
    if (record.booking.firstReason) line('    the server said', `"${record.booking.firstReason}"`);
    line('Q6  double-booking', record.booking.duplicate.summary);
    line('Q7  DELETE reverses it', record.booking.reversal.summary);
  }

  const stranded = record.booking?.leftBehind;
  if (stranded) {
    rule('⚠️  Cleanup — could not undo');
    console.log(`  ${subject.last_name} still holds bookings on event ${EVENT_ID}. Clear them in the Clubworx UI.`);
  }
  if (record.membership.assigned && !record.membership.reused && WRITE) {
    rule('⚠️  Permanent');
    console.log(`  A ${PLAN_NAME} was assigned to ${subject.last_name}. Memberships have no delete endpoint.`);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `60-${record.ranAt.replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(record, null, 2));

  const writes = assigner.assign.writes + booker.book.writes + booker.cancel.writes;
  console.log(`\n${get.calls} reads, ${writes} writes. Summary written to probes/out/${path.basename(file)}`);
}

main().catch(err => {
  console.error(`probe failed: ${err.message}`);
  process.exitCode = 1;
});
