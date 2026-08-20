#!/usr/bin/env node
/**
 * staff-site#63 — can a contact be created as a member, and can the pass ride along?
 *
 *   node probes/run-63.mjs --dry-run              # the plan and every request, zero network
 *   node probes/run-63.mjs                        # read-only: what already exists, and the plan
 *   node probes/run-63.mjs --event=<id> --write   # creates up to 2 PERMANENT contacts, then books
 *   node probes/run-63.mjs --encoding=form        # force the body shape instead of discovering it
 *   node probes/run-63.mjs --dev-vars=<path>
 *
 * **This is the gate on the whole #46 build.** `POST /api/v2/members` is the one
 * write in the chain nobody has run. #60 proved the member + School Pass route
 * end to end, but it did not *create* its members — they were converted from
 * prospects by hand in the Clubworx UI beforehand. #49 created contacts, but
 * through `POST /api/v2/prospects`. So every claim about `POST /members` in the
 * design spec comes from `uj/automations/ClubworxAPI_docs.md` and nothing else,
 * and that reference has already been wrong twice on this map — #50's `DELETE`
 * verdict, and the 50-of-57 plan truncation.
 *
 * The questions, from #63:
 *
 *   1. Does `POST /api/v2/members` succeed?
 *   2. Is the resulting contact bookable once it holds an active School Pass?
 *   3. Does `membership_plan_id` on create produce a usable pass?
 *   4. If (3) works, what `start_date` does the pass get?
 *
 * ⚠️ What this probe can leave behind, in descending order of permanence:
 *
 *   - **Up to two contacts.** Clubworx exposes no delete for them. They are
 *     `MEMBER_PROBE_CONTACTS` and nothing else — the guard in `lib/write.mjs`
 *     refuses anything outside the Wayfinder identity before the network is
 *     touched. E is attempted only if D is *seen to exist*, so an endpoint that
 *     refuses costs one contact rather than two.
 *   - **Up to two School Passes.** `POST /memberships` has no delete either. A
 *     pass lapses at `expiration_date`; it cannot be removed. Searched for
 *     first, and an active one is reused.
 *   - **Bookings**, which are the reversible part: #60 measured
 *     `DELETE /bookings/:id` reversing cleanly, given `contact_key` in a
 *     form-encoded body. This probe cancels what it books and re-reads to check.
 *
 * Two rules shape the code more than anything else:
 *
 *   **Verify by re-reading, never by the status code.** #49 found a successful
 *   create answers `200` where a reader expects `201`; #50 read a malformed
 *   request's `401` as a permissions wall. Every verdict below comes from a
 *   subsequent search. `describeMemberCreation` keeps the status as a single
 *   boolean recording whether Clubworx told the truth — which is a finding in
 *   its own right, and not the same question as what is in the database.
 *
 *   **Search all three status views.** #49 established the three contact
 *   endpoints are disjoint views by status, and #60 was bitten on 2026-08-18 by
 *   searching only `/prospects` after somebody converted its contacts. A probe
 *   that looked only in `/members` could report "absent" about a contact that
 *   exists — and then create a second, permanently.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGetter } from './lib/http.mjs';
import { createPoster } from './lib/write.mjs';
import { createBooker } from './lib/booking.mjs';
import { createMembershipAssigner } from './lib/membership.mjs';
import { loadAccountKey } from './lib/key.mjs';
import { MEMBER_PROBE_CONTACTS, pickProbeRows, plusTag } from './lib/identity.mjs';
import { redact } from '../src/request.js';
import { errorMessageOf } from '../src/errors.js';
import {
  summariseContacts,
  summariseBookings,
  summariseMemberships,
  classifyWrite,
  describeMemberCreation,
  describeCreatedPass,
  describeCancellation,
  findPlanByName,
  describeLeadTime,
  summariseEvents,
} from './lib/report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, 'out');

const args = process.argv.slice(2);
const flag = name => args.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

const DRY_RUN = args.includes('--dry-run');
const WRITE = args.includes('--write');
const EVENT_ID = flag('event') ?? null;
const PLAN_NAME = flag('plan') ?? 'School Pass';
const FORCED_ENCODING = flag('encoding') ?? null;
const DEV_VARS = flag('dev-vars') || path.join(HERE, '..', '.dev.vars');

/** The three disjoint status views (#49). Searching one of them is not searching. */
const CONTACT_TYPES = ['prospects', 'members', 'non_attending_contacts'];

const TAG_EMAILS = [...new Set(MEMBER_PROBE_CONTACTS.map(c => c.email))];

/**
 * Which body shapes to try, in order.
 *
 * JSON first because it is the only contact-create shape anyone here has
 * *measured* — #49 sent it to `POST /prospects` and got a 200. The reference
 * calls `POST /members` form-encoded, and the two write paths #60 measured
 * (`/memberships`, `/bookings`) are form-encoded, so the reference may well be
 * right; it has simply not earned being believed on this map.
 *
 * The fallback is safe only because a re-read sits between the two attempts. A
 * blind retry of a create is how you get a permanent duplicate out of a request
 * that actually worked.
 */
const KNOWN_ENCODINGS = ['json', 'form'];
const ENCODINGS_TO_TRY = FORCED_ENCODING ? [FORCED_ENCODING] : KNOWN_ENCODINGS;

// `createPoster` refuses an unknown encoding, but it is not constructed until
// after the survey and the plan lookup — so a typo in `--encoding` would be
// paid for with a dozen requests and then throw. Checked at the boundary, where
// it costs nothing.
if (FORCED_ENCODING && !KNOWN_ENCODINGS.includes(FORCED_ENCODING)) {
  console.error(
    `unknown --encoding=${FORCED_ENCODING} — expected ${KNOWN_ENCODINGS.join(' or ')}`,
  );
  process.exit(1);
}

/** Big enough to see past the default 50, which silently hid this plan (#60). */
const PAGE_SIZE = 200;
const WINDOW_DAYS = 21;

/** ~75 requests/minute, one in flight — the pace #51 measured as clean. */
const GAP_MS = 800;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const line = (label, value) => console.log(`  ${label.padEnd(38)} ${value}`);
const rule = title => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);

/**
 * The safe, human-readable reason a call failed — or null if it did not.
 *
 * One definition, because the alternative was three — and two of those three
 * passed the wrong thing as the secret. `redact(message, x)` replaces every
 * occurrence of `x`, so handing it a space replaces the spaces and leaves the
 * account key intact; `run-60.mjs` handed it a NUL byte, which matches nothing
 * at all and quietly redacts nothing. Both satisfy redact's "refusing to no-op"
 * guard while doing the opposite of redacting, and both only surface on an
 * error path — the one place a key is most likely to be echoed back. Found by
 * the review on this ticket, and fixed in `run-60.mjs` too.
 *
 * @param {{body?: unknown}} sample
 * @param {string} accountKey
 */
const reasonOf = (sample, accountKey) => {
  const message = errorMessageOf(sample?.body);
  return message ? redact(message, accountKey) : null;
};

const isoDay = offsetDays => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};

/**
 * Find every probe contact, in whichever status view holds it.
 *
 * Returns rows tagged with the endpoint they were found in — which is not
 * bookkeeping here but part of question 1's answer. Whether `POST /members`
 * produces something that actually appears in `/members` is exactly the sort of
 * thing the reference asserts and nobody has watched.
 */
async function findAll(get) {
  const found = [];
  for (const type of CONTACT_TYPES) {
    for (const email of TAG_EMAILS) {
      const res = await get(type, { email });
      const rows = pickProbeRows(res.body);
      const summary = summariseContacts(res.body, rows.map(r => r.contact_key));
      if (summary.strangers) {
        line(
          `${type} +${plusTag(email)}`,
          `${summary.strangers} row(s) not ours (counted, dropped)`,
        );
      }
      found.push(...rows.map(r => ({ ...r, status_endpoint: type })));
      await sleep(GAP_MS);
    }
  }
  const byKey = new Map(found.map(row => [row.contact_key, row]));
  return [...byKey.values()];
}

/** The rows matching one wanted contact. Surname *and* email — #49's D/E share A's address. */
const matching = (rows, contact) =>
  rows.filter(r => r.last_name === contact.last_name && r.email === contact.email);

/** Question 0, in effect: what is already there, so a re-run costs nothing permanent. */
async function survey(get) {
  rule('0. What already exists — search before any create');

  const rows = await findAll(get);
  for (const contact of MEMBER_PROBE_CONTACTS) {
    const mine = matching(rows, contact);
    line(
      `${contact.label} ${contact.last_name}`,
      mine.length
        ? `EXISTS in ${mine.map(r => r.status_endpoint).join(', ')} · ${mine[0].contact_key}`
        : 'not present — would be created',
    );
  }
  return rows;
}

/**
 * Turn the plan *name* into an id — and refuse to guess.
 *
 * Lifted wholesale from #60's reasoning: on 2026-08-18 the default page
 * returned exactly 50 plans of 57 and `School Pass` was among the seven that
 * never arrived, producing a "plan not found" that would have been entirely
 * wrong. A full page is treated as a truncated one.
 */
async function resolvePlan(get) {
  rule(`Resolve the membership plan by name — "${PLAN_NAME}"`);

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
    line(
      'cost',
      `upfront ${found.plan.upfront_payment_amount ?? 'n/a'} · recurring ${found.plan.recurring_payment_amount ?? 'none'}`,
    );
  } else {
    line('resolved', 'NOT FOUND');
  }

  return { ...found, status: res.status };
}

/**
 * Create one contact through `POST /members`, and find out what actually happened.
 *
 * The loop over encodings is the delicate part. Between the two attempts sits a
 * full three-view re-read, so the second attempt only ever runs against a
 * database that has been *observed* not to contain the contact. Without that,
 * a create that succeeded while answering something unreadable would be retried
 * into a permanent duplicate.
 */
async function createMember(get, { contact, accountKey, planId, live, existing }) {
  const already = matching(existing, contact);
  if (already.length) {
    line(
      `${contact.label} create`,
      `SKIPPED — already exists (${already[0].contact_key}), nothing permanent to add`,
    );
    return {
      label: contact.label,
      reused: true,
      contactKey: already[0].contact_key,
      statusEndpoint: already[0].status_endpoint,
      attempts: [],
      creation: { verdict: 'created', landed: true, contactKey: already[0].contact_key },
    };
  }

  const payload = { ...contact, ...(planId ? { membership_plan_id: planId } : {}) };
  const attempts = [];
  let creation = null;
  let rows = existing;

  for (const encoding of ENCODINGS_TO_TRY) {
    const post = createPoster({ accountKey, live, encoding });
    const res = await post('members', payload);
    const outcome = classifyWrite(res);
    const reason = reasonOf(res, accountKey);

    line(
      `${contact.label} POST /members (${encoding})`,
      res.refused
        ? `REFUSED locally: ${res.refused}`
        : res.dryRun
          ? `would send ${JSON.stringify(res.wouldSend)}`
          : `HTTP ${res.status ?? 'n/a'} ${outcome.outcome}` +
            (reason ? ` · "${reason}"` : '') +
            (res.bodyText ? ` · ${res.bodyText.slice(0, 160)}` : ''),
    );

    if (res.dryRun) {
      attempts.push({ encoding, dryRun: true });
      return { label: contact.label, reused: false, dryRun: true, attempts, creation: null };
    }

    await sleep(GAP_MS);

    // The verdict. Not the status code — the database.
    rows = await findAll(get);
    const mine = matching(rows, contact);
    creation = describeMemberCreation({ create: res, found: mine });

    attempts.push({
      encoding,
      status: res.status ?? null,
      error: res.error ?? null,
      refused: res.refused ?? null,
      reason,
      bodyText: res.bodyText ?? null,
      verdict: creation.verdict,
    });

    line(`${contact.label} re-read says`, creation.summary);
    if (creation.statusAgrees === false && creation.verdict !== 'refused') {
      line('  ⚠️  status vs database', 'the status code did not describe what happened');
    }

    if (creation.landed) {
      const where = mine.map(r => r.status_endpoint).join(', ');
      line(`${contact.label} appears in`, where || '(nowhere — see above)');
      return {
        label: contact.label,
        reused: false,
        contactKey: creation.contactKey,
        statusEndpoint: mine[0]?.status_endpoint ?? null,
        appearsIn: mine.map(r => r.status_endpoint),
        attempts,
        creation,
      };
    }

    if (ENCODINGS_TO_TRY.length > 1 && encoding !== ENCODINGS_TO_TRY[ENCODINGS_TO_TRY.length - 1]) {
      line('  retrying', 'the re-read found nothing, so a second shape cannot duplicate');
    }
  }

  return { label: contact.label, reused: false, contactKey: null, attempts, creation };
}

/** What pass, if any, the contact now holds — and on whose terms. */
async function readPass(get, { contactKey, planId, on, requested = null }) {
  const res = await get('memberships', { contact_key: contactKey });
  const held = summariseMemberships(res.body, planId, { on });
  const pass = describeCreatedPass({ states: held.planStates, on, requested });
  return { pass, held, status: res.status };
}

/** Question 2, first half: the measured two-call route, on a contact made by /members. */
async function assignPass(get, assigner, { contact, planId, live }) {
  rule(`${contact.label} — School Pass through the measured two-call route`);

  const before = await readPass(get, { contactKey: contact.contactKey, planId, on: isoDay(0) });
  line('holds this plan already', `${before.held.holdsPlan} · active ${before.held.holdsActivePlan}`);
  await sleep(GAP_MS);

  // Memberships have no delete. A re-run that skipped this would pile up
  // permanent duplicates, and an *expired* pass is still a held plan — treating
  // that as good enough would leave the booking to fail for a reason already seen.
  if (before.held.holdsActivePlan) {
    line('assign', 'SKIPPED — an active pass is already held');
    return { reused: true, before: before.pass, after: before.pass, assigned: null };
  }

  const startDate = isoDay(0);
  const res = await assigner.assign({
    contact_key: contact.contactKey,
    membership_plan_id: planId,
    start_date: startDate,
  });
  const outcome = classifyWrite(res);
  const reason = reasonOf(res, accountKey);

  line(
    'assign',
    res.refused
      ? `REFUSED locally: ${res.refused}`
      : res.dryRun
        ? `would POST ${JSON.stringify(res.wouldSend)}`
        : `HTTP ${res.status ?? 'n/a'} ${outcome.outcome}` + (reason ? ` · "${reason}"` : ''),
  );
  if (res.dryRun) return { dryRun: true };
  await sleep(GAP_MS);

  const after = await readPass(get, {
    contactKey: contact.contactKey,
    planId,
    on: isoDay(0),
    requested: startDate,
  });
  line('pass now', after.pass.summary);
  line('honoured the start_date we sent', String(after.pass.honouredRequest));

  return {
    reused: false,
    requested: startDate,
    assigned: { status: res.status ?? null, outcome: outcome.outcome, reason },
    before: before.pass,
    after: after.pass,
  };
}

/** Questions 3 and 4: did the pass ride along on the create, and on what dates? */
async function inspectRiderPass(get, { contact, planId }) {
  rule(`${contact.label} — questions 3 and 4: did the pass ride along on the create?`);

  const { pass, held, status } = await readPass(get, {
    contactKey: contact.contactKey,
    planId,
    on: isoDay(0),
  });

  line('memberships held', `HTTP ${status} · ${held.count}`);
  line('Q3  pass granted by the create', `${pass.granted} · usable now: ${pass.active}`);
  if (pass.granted) {
    line('Q4  start_date Clubworx chose', `${pass.startDate ?? 'n/a'}`);
    line('    starts on the creation day', String(pass.startsOnCreationDay));
    line('    expires', `${pass.expirationDate ?? 'n/a'} · span ${pass.spanDays ?? 'n/a'}d`);
  }
  line('fields returned', held.fields.join(', ') || '(none)');

  return { pass, count: held.count };
}

/** The event, before anything is booked into it. */
async function inspectEvent(get, eventId) {
  rule('The event — capacity and lead time');

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
  if (lead.past) line('⚠️  lead time', 'this event has already started');
  else if (lead.withinLeadTime) line('⚠️  lead time', `inside ${lead.minLeadHours}h — may be refused`);

  return {
    found: true,
    event_id: row.event_id,
    event_name: row.event_name,
    event_start_at: row.event_start_at,
    spaces_available: row.spaces_available,
    event_full: row.event_full,
    lead,
  };
}

/**
 * Question 2, the part that matters: does a contact made by `POST /members` book?
 *
 * Books, verifies by re-reading the contact's bookings, then cancels and
 * verifies that too. The booking is the only thing here that can be taken back,
 * so it is the only thing this probe is willing to leave undone by accident.
 */
async function probeBooking(get, booker, { contact, eventId, accountKey }) {
  rule(`${contact.label} — question 2: does it book?`);

  const count = async () => {
    const res = await get('bookings', { contact_key: contact.contactKey });
    return summariseBookings(res.body, [contact.contactKey]);
  };

  const before = await count();
  line('bookings held before', String(before.ours));
  await sleep(GAP_MS);

  const res = await booker.book({ contact_key: contact.contactKey, event_id: eventId });
  const outcome = classifyWrite(res);
  line(
    'book',
    res.refused
      ? `REFUSED locally: ${res.refused}`
      : res.dryRun
        ? `would POST ${JSON.stringify(res.wouldSend)}`
        : `HTTP ${res.status ?? 'n/a'} ${outcome.outcome}` +
          (res.bookingId ? ` · booking ${res.bookingId}` : '') +
          (reasonOf(res, accountKey) ? ` · "${reasonOf(res, accountKey)}"` : ''),
  );
  if (res.dryRun) return { dryRun: true };
  await sleep(GAP_MS);

  const afterBook = await count();
  line('bookings held after', String(afterBook.ours));
  // The status said something; this is what the database says.
  const booked = afterBook.ours > before.ours;
  line('Q2  verdict from the re-read', booked ? 'BOOKED' : 'not booked');
  await sleep(GAP_MS);

  const cancellations = [];
  if (res.bookingId) {
    const cancelled = await booker.cancel(res.bookingId);
    cancellations.push({
      id: String(res.bookingId),
      status: cancelled.status ?? null,
      refused: cancelled.refused ?? null,
      reason: reasonOf(cancelled, accountKey),
    });
    line(
      `cancel ${res.bookingId}`,
      cancelled.refused
        ? `REFUSED locally: ${cancelled.refused}`
        : `HTTP ${cancelled.status ?? 'n/a'}` + (reasonOf(cancelled, accountKey) ? ` · "${reasonOf(cancelled, accountKey)}"` : ''),
    );
    await sleep(GAP_MS);
  }

  const afterCancel = cancellations.length ? await count() : null;
  if (afterCancel) line('bookings held after cancelling', String(afterCancel.ours));

  const reversal = describeCancellation({
    cancel: cancellations[cancellations.length - 1] ?? null,
    countBefore: afterBook.ours,
    countAfter: afterCancel?.ours ?? null,
  });

  return {
    dryRun: false,
    booked,
    outcome: outcome.outcome,
    status: res.status ?? null,
    reason: reasonOf(res, accountKey),
    bookingId: res.bookingId ?? null,
    counts: {
      before: before.ours,
      afterBook: afterBook.ours,
      afterCancel: afterCancel?.ours ?? null,
    },
    cancellations,
    reversal,
    leftBehind: (afterCancel?.ours ?? afterBook.ours) > before.ours,
  };
}

function printDryRun() {
  console.log('--dry-run: no requests issued, nothing written.\n');

  let n = 0;
  const req = (verb, p, params) =>
    console.log(
      `  ${String(++n).padStart(2)}. ${verb.padEnd(6)} /${p}${params ? `?${params}` : ''}`,
    );
  const sweep = () => {
    for (const type of CONTACT_TYPES) for (const email of TAG_EMAILS) req('GET', type, `email=${email}`);
  };

  console.log('0. Search all three status views before creating anything (#49):');
  sweep();

  console.log('\nResolve the plan by name:');
  req('GET', 'membership_plans', `page_size=${PAGE_SIZE}`);

  console.log(`\nQ1. Create D — plain, encodings tried in order: ${ENCODINGS_TO_TRY.join(' then ')}`);
  for (const encoding of ENCODINGS_TO_TRY) {
    req('POST', 'members');
    console.log(`        ${encoding}-encoded · { first_name, last_name, dob, email }`);
    console.log('        ⚠️ PERMANENT — contacts have no delete endpoint');
    console.log('        then re-read all three views before any retry:');
    sweep();
    console.log('        (a second shape is only sent if the re-read found nothing)');
  }

  console.log('\nQ2a. Give D a pass through the measured two-call route:');
  req('GET', 'memberships', 'contact_key=<D>');
  req('POST', 'memberships');
  console.log(`        { contact_key: <D>, membership_plan_id: <"${PLAN_NAME}">, start_date: ${isoDay(0)} }`);
  console.log('        ⚠️ PERMANENT — memberships have no delete endpoint');
  req('GET', 'memberships', 'contact_key=<D>');

  console.log('\nQ3–4. Create E with membership_plan_id on the create call:');
  console.log('        ONLY IF D was seen to exist — a refusing endpoint costs one contact, not two');
  req('POST', 'members');
  console.log('        ⚠️ PERMANENT — contact *and* possibly a pass, neither deletable');
  sweep();
  req('GET', 'memberships', 'contact_key=<E>');

  if (!EVENT_ID) {
    console.log('\nQ2b. Booking — NOTHING PLANNED. Pass --event=<id>.');
  } else {
    console.log(`\nQ2b. Book D and E into event ${EVENT_ID}, then cancel both:`);
    req('GET', 'events', `event_starts_after=${isoDay(-1)}&event_ends_before=${isoDay(WINDOW_DAYS)}&page_size=${PAGE_SIZE}`);
    for (const who of ['D', 'E']) {
      req('GET', 'bookings', `contact_key=<${who}>`);
      req('POST', 'bookings');
      req('GET', 'bookings', `contact_key=<${who}>`);
      req('DELETE', 'bookings/<id>');
      console.log('        body: account_key=…&contact_key=…  ← reversible, measured in #60');
      req('GET', 'bookings', `contact_key=<${who}>`);
    }
  }

  console.log(`\n~${n} requests, paced at one per ${GAP_MS}ms (~${Math.round(60_000 / GAP_MS)}/min), per #51.`);
  console.log(
    'Every contact is searched for first, so a re-run creates nothing.\n' +
      '⚠️  A first run creates up to TWO PERMANENT contacts and up to TWO PERMANENT passes.\n' +
      '    ACCESS.md §4: the #49 three-contact authorisation is SPENT. This needs a new one.\n',
  );
}

async function main() {
  if (DRY_RUN) {
    printDryRun();
    return;
  }

  // `probes/README.md`: "**`--write` without `--event=<id>` stops.**" That rule
  // was written for the booking probes, but it bites hardest here. Questions 1,
  // 3 and 4 need no event, so this script would happily spend two permanent
  // contacts and two permanent passes and then print "booking SKIPPED" — buying
  // permanence and leaving question 2, the one that decides whether any of it
  // is usable, unanswered. Refused before the key is even read.
  if (WRITE && !EVENT_ID) {
    console.error(
      'refusing to write without --event=<id>.\n' +
        '  Questions 1, 3 and 4 need no event, but question 2 does, and a --write run\n' +
        '  creates permanent contacts and permanent passes either way. Run read-only\n' +
        '  first to list candidates, then pass the event you chose.',
    );
    process.exitCode = 1;
    return;
  }

  const accountKey = loadAccountKey(DEV_VARS);
  const get = createGetter({ accountKey });

  console.log(
    WRITE
      ? '⚠️  staff-site#63 probe — WRITES ENABLED, against production Clubworx'
      : 'staff-site#63 probe — read-only. Pass --event=<id> --write to create and book.',
  );

  const record = {
    probe: 'staff-site#63',
    ranAt: new Date().toISOString(),
    write: WRITE,
    encodingsTried: ENCODINGS_TO_TRY,
  };

  const existing = await survey(get);

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

  const [wantD, wantE] = MEMBER_PROBE_CONTACTS;

  rule('1. Question 1 — does POST /members create a contact?');
  const d = await createMember(get, {
    contact: wantD,
    accountKey,
    planId: null,
    live: WRITE,
    existing,
  });
  record.d = d;

  const save = () => {
    mkdirSync(OUT_DIR, { recursive: true });
    const at = path.join(OUT_DIR, `63-${record.ranAt.replace(/[:.]/g, '-')}.json`);
    writeFileSync(at, JSON.stringify(record, null, 2));
    console.log(`\n${get.calls} reads. Summary written to probes/out/${path.basename(at)}`);
  };

  // "Nothing was sent" and "something was sent and did not land" are opposite
  // findings, and only one of them is an answer to question 1. Collapsing them
  // would let a read-only run report that POST /members does not work.
  if (d.dryRun) {
    rule('Read-only — stopped before the first create');
    console.log(
      '  Nothing was sent, so question 1 is still open. Everything above is a read.\n' +
        '  Re-run with --write to answer it — and read ACCESS.md §4 first: the #49\n' +
        '  three-contact authorisation is spent, and D and E are a new decision.',
    );
    save();
    return;
  }

  // The gate. If D is not in the database, E would be a second permanent
  // contact bought for nothing.
  if (!d.contactKey) {
    rule('Stopped — question 1 answered, and the answer closes the rest');
    console.log(
      '  POST /members did not produce a contact under any shape tried.\n' +
        '  E is NOT attempted: it would cost a second permanent record to learn nothing new.\n' +
        "  The spec's fallback stands — create via POST /prospects (#49) and let the pass move them.",
    );
    save();
    process.exitCode = 1;
    return;
  }
  await sleep(GAP_MS);

  const assigner = createMembershipAssigner({
    accountKey,
    allowedContactKeys: [d.contactKey],
    live: WRITE,
  });
  record.dPass = await assignPass(get, assigner, {
    contact: d,
    planId: plan.plan.id,
    live: WRITE,
  });
  await sleep(GAP_MS);

  rule('2. Questions 3 and 4 — can the pass ride along on the create?');
  const rowsNow = await findAll(get);
  const e = await createMember(get, {
    contact: wantE,
    accountKey,
    planId: plan.plan.id,
    live: WRITE,
    existing: rowsNow,
  });
  record.e = e;

  if (e.contactKey) {
    await sleep(GAP_MS);
    record.ePass = await inspectRiderPass(get, { contact: e, planId: plan.plan.id });
  }

  if (EVENT_ID) {
    await sleep(GAP_MS);
    record.event = await inspectEvent(get, EVENT_ID);
    await sleep(GAP_MS);

    const subjects = [d, e].filter(c => c?.contactKey);
    const booker = createBooker({
      accountKey,
      allowedContactKeys: subjects.map(c => c.contactKey),
      live: WRITE,
    });

    record.bookings = {};
    for (const subject of subjects) {
      record.bookings[subject.label] = await probeBooking(get, booker, {
        contact: subject,
        eventId: EVENT_ID,
        accountKey,
      });
      await sleep(GAP_MS);
    }
    record.bookerWrites = booker.book.writes + booker.cancel.writes;
  } else {
    rule('Question 2 — booking SKIPPED');
    console.log('  No --event=<id> given. The event is never chosen automatically.');
  }

  rule('Verdicts');
  line('Q1  POST /members creates a contact', `${Boolean(d.contactKey)} · ${d.creation?.verdict ?? 'n/a'}`);
  if (d.attempts.length) {
    const worked = d.attempts.find(a => a.verdict === 'created');
    line('    body shape that worked', worked ? worked.encoding : 'none');
    for (const a of d.attempts) line(`    ${a.encoding}`, `HTTP ${a.status ?? 'n/a'} → ${a.verdict}`);
  }
  if (d.appearsIn) line('    it appears in', d.appearsIn.join(', '));
  if (record.dPass?.after) line('Q2  D holds an active pass', String(record.dPass.after.active));
  if (record.bookings?.D) line('Q2  D books', String(record.bookings.D.booked));
  line('Q3  pass rides along on create', String(record.ePass?.pass.granted ?? 'not reached'));
  if (record.ePass?.pass.granted) {
    line('    usable now', String(record.ePass.pass.active));
    line('Q4  start_date it received', `${record.ePass.pass.startDate ?? 'n/a'}`);
    line('    = the creation day', String(record.ePass.pass.startsOnCreationDay));
    line('    span', `${record.ePass.pass.spanDays ?? 'n/a'}d vs two-call ${record.dPass?.after?.spanDays ?? 'n/a'}d`);
  }
  if (record.bookings?.E) line('Q2  E books', String(record.bookings.E.booked));

  const permanent = [d, e].filter(c => c?.contactKey && !c.reused);
  const passes = [
    record.dPass?.reused === false ? { label: 'D', pass: record.dPass.after } : null,
    record.ePass?.pass?.granted ? { label: 'E', pass: record.ePass.pass } : null,
  ].filter(Boolean);

  if ((permanent.length || passes.length) && WRITE) {
    rule('⚠️  Permanent — record these in ACCESS.md §4');
    for (const c of permanent) {
      console.log(`  contact ${c.label}  ${c.contactKey}  (${c.appearsIn?.join(', ') ?? 'unknown view'})`);
    }
    // A pass is as undeletable as a contact and is far easier to forget, because
    // nothing on the contact's row shouts about it. #60's write-up records its
    // one pass by id and expiry; this does the same for both of these.
    for (const { label, pass } of passes) {
      console.log(
        `  pass    ${label}  ${PLAN_NAME} · start ${pass.startDate ?? 'n/a'} · expires ${pass.expirationDate ?? 'n/a'}`,
      );
    }
    console.log(
      '  Neither contacts nor memberships have a delete endpoint. A pass lapses at its\n' +
        '  expiration_date; a contact must be removed by hand in the Clubworx UI.',
    );
  }

  const stranded = Object.entries(record.bookings ?? {}).filter(([, b]) => b?.leftBehind);
  if (stranded.length) {
    rule('⚠️  Cleanup — could not undo');
    for (const [label] of stranded) {
      console.log(`  ${label} still holds a booking on event ${EVENT_ID}. Clear it in the Clubworx UI.`);
    }
  }

  save();
}

main().catch(err => {
  console.error(`probe failed: ${err.message}`);
  process.exitCode = 1;
});
