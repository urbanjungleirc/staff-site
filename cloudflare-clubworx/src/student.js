/**
 * The per-student write chain — the only code in this repo that creates
 * permanent records.
 *
 * staff-site#69. Design: `docs/superpowers/specs/2026-08-19-school-group-booking-design.md`
 * §10 (the write chain), §11 (refusals and retries), §12 (irreversibility).
 *
 * ---------------------------------------------------------------------------
 * Read this before changing anything below
 * ---------------------------------------------------------------------------
 * **Contacts and memberships cannot be deleted.** Not by this Worker, not by
 * the API at all — 42 endpoints reviewed, no delete on either (§12). A contact
 * written by mistake sits beside ~60,000 real people until somebody removes it
 * by hand in the Clubworx UI. Bookings are the one reversal there is.
 *
 * Everything odd-looking in here follows from that asymmetry:
 *
 *   - **Every write is verified by re-reading the resource, never by the status
 *     code.** An accepted-but-silent failure and a success are the same 200. It
 *     is how #60 established booking idempotency — by counting either side.
 *   - **A retry re-reads first.** A connection error on `POST /members` may have
 *     landed; retrying blind is how one student becomes two permanent records.
 *   - **Anything uncertain refuses.** A read that fails, a body that is not a
 *     list, a date that will not parse — none of them are guessed past, because
 *     the cheap-looking guess is the one that writes.
 *
 * ---------------------------------------------------------------------------
 * The unit is one student, and it is all-or-nothing
 * ---------------------------------------------------------------------------
 * **D2** — the student is the only unit whose failure boundary is a sentence
 * staff can say out loud: *"the first six are in, the rest are not."* Per-event
 * strands a child who turns up to session 4 and is not on the list.
 *
 * **D3** — any failure abandons the student and **cancels the bookings this run
 * already made for them**. A student is in every session or in none, never
 * half-booked. The rollback is what makes that true rather than nominal.
 *
 * It leaves a **stranded student**: a permanent contact and pass, no bookings.
 * That is a routine outcome under D3, not an edge case, and the result names it
 * so staff can finish it by hand.
 *
 * ---------------------------------------------------------------------------
 * The chain
 * ---------------------------------------------------------------------------
 * ```
 * matched → re-read membership → ensure School Pass → book ×N → verify
 * new     → create contact WITH the pass ───────────→ book ×N → verify
 * ```
 *
 * **D4 — no membership read for a contact we just created**, which provably
 * holds none, and **read at Apply for matched contacts**. The read is only ever
 * wasted on a contact we just created; for a student who already holds a
 * covering pass, reading and assigning cost the same single request, so blind
 * assignment buys nothing in exactly the case where it would duplicate.
 *
 * **D14 — the membership is re-read immediately before its own write**, not at
 * preview. Contact and booking both have server-side idempotency to fall back
 * on; the membership has none. Nothing else is re-validated.
 *
 * ---------------------------------------------------------------------------
 * What this deliberately does not do
 * ---------------------------------------------------------------------------
 * **It does not decide the match.** `contactKey` arrives from the page, which
 * got it from `GET /contacts` (#68) and resolved it in `school-booking/
 * identity.js`. A null key means `new`, and `new` creates a contact — so the
 * Worker re-reads after the create rather than trusting that decision blindly.
 *
 * **It does not re-validate the event list.** D14 is explicit that only the
 * membership is re-read. The lead-time and pass-coverage gates below run
 * against the dates the page sends; they are a backstop at the point of writing,
 * not a second source of truth. ADR 0007 gives the lead-time gate one more
 * input — the event ids an operator acknowledged — and no more authority: it
 * narrows who the refusal applies to, and decides nothing about them.
 *
 * **It does not run the circuit breaker.** D7 halts a *run* after 3 consecutive
 * failures, and a run is many students across many calls — the page's job. This
 * handles one student and reports honestly enough for the page to count.
 */

import { assessPass, summariseMemberships } from './memberships.js';
import { isRealDay, parsePlanDuration, passCoverageEnd, perthDay } from './duration.js';
import {
  ALREADY_BOOKED_STATE,
  BOOKED,
  FAILED,
  bookEvent,
  cancelRunBookings,
  readBookings,
} from './bookings.js';
import { countedClient } from './clubworx.js';
import { PAGE_SIZE } from './contacts.js';
import { MIN_LEAD_HOURS } from './events.js';
import { isRetryable, upstreamMessage, upstreamReason } from './upstream.js';

/**
 * The lead-time rule is defined once, in `events.js`, and re-exported here for
 * the callers that already read it off the write chain.
 *
 * It lives with the events because both halves of it are about an event: the
 * picker greys a session out with it (#67) and this chain hard-stops on it
 * (D9). Two copies would drift, and the drift shows up as a run refused at its
 * last step for a session the page had shown as selectable — with nothing on
 * either screen to say why the two disagreed.
 *
 * ADR 0007 makes that sharing load-bearing twice over: the two halves now share
 * one list of exceptions as well as one definition of the rule, and they must
 * not be able to disagree about either.
 */
export { MIN_LEAD_HOURS };

/** #51 measured ~18 s of throttling. Two attempts, then the page is told. */
export const RETRY_BACKOFF_MS = 20_000;
export const MAX_ATTEMPTS = 2;

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * The only fields that may be sent to `POST /members`.
 *
 * An allowlist, not a spread of whatever the caller passed. `probes/lib/write.mjs`
 * makes the same point about its own bookkeeping fields: *"posting it would put a
 * field Clubworx never asked for onto a record nobody can delete."* The request
 * body arrives over HTTP from a page this Worker does not control, and an extra
 * key in it would be written onto a permanent contact — silently, since Clubworx
 * answered 200 either way.
 *
 * `membership_plan_id` is added separately, from the resolved plan rather than
 * from the request's student object.
 */
const MEMBER_FIELDS = ['first_name', 'last_name', 'dob', 'email'];

/** Case- and whitespace-insensitive, for comparing a field against what we sent. */
const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();


/**
 * Find the contact this run just created, by re-reading `/members`.
 *
 * The verdict on a create comes from here, never from the status code (#63 did
 * exactly this, and it is why the probe could tell a create that worked from
 * one that did not). It also supplies the `contact_key` the rest of the chain
 * uses — the create response's own key is not trusted, because a response shape
 * this reference has been wrong about twice is not evidence.
 *
 * @returns {Promise<{state: 'found'|'absent'|'ambiguous'|'error', contactKey?: string,
 *   reason?: string, message?: string|null, upstreamStatus?: number|null}>}
 */
async function findCreatedContact({ client, student }) {
  const res = await client.get('members', {
    last_name: student.last_name,
    dob: student.dob,
    page_size: PAGE_SIZE,
  });

  if (!res.ok) {
    return {
      state: 'error',
      reason: upstreamReason(res),
      message: upstreamMessage(res),
      upstreamStatus: res.status,
    };
  }
  if (!Array.isArray(res.body)) {
    return {
      state: 'error',
      reason: 'upstream-error',
      message: `members answered ${res.status} with a body that is not a list of contacts`,
      upstreamStatus: res.status,
    };
  }
  // A page that came back exactly full is indistinguishable from a complete
  // list, so "not found" on one is not an answer (#51).
  if (res.body.length >= PAGE_SIZE) {
    return {
      state: 'error',
      reason: 'search-not-narrowed',
      message:
        `members returned a full page of ${PAGE_SIZE}, so this cannot be told apart from a ` +
        'truncated list, and a create cannot be confirmed against it',
      upstreamStatus: res.status,
    };
  }

  const mine = res.body.filter(
    row =>
      row?.contact_key &&
      same(row.first_name, student.first_name) &&
      same(row.last_name, student.last_name) &&
      String(row.dob ?? '') === String(student.dob) &&
      same(row.email, student.email),
  );

  if (mine.length === 1) return { state: 'found', contactKey: mine[0].contact_key };
  if (mine.length === 0) return { state: 'absent' };
  return {
    state: 'ambiguous',
    reason: 'contact-ambiguous',
    message:
      `${mine.length} contacts now match this student exactly. Either the dedup search missed one ` +
      'or this run has created a duplicate — and contacts cannot be deleted through the API, so ' +
      'this needs a person in the Clubworx UI before the student is booked into anything.',
  };
}

/**
 * Create the contact and its School Pass in one request, then prove it landed.
 *
 * `POST /members`, **JSON**, with `membership_plan_id` riding along — measured
 * in #63, which answered 200 on the first attempt. The reference calls this
 * endpoint form-encoded and that shape has never been tested; do not "correct"
 * it on the reference's word. (`/memberships` genuinely is form-encoded. The
 * encoding is per-endpoint, not per-API.)
 *
 * The re-read between attempts is the whole safety property: a retry can only
 * happen once a read has proved the previous attempt did not land.
 */
async function createContactWithPass({ client, student, membershipPlanId, sleep }) {
  const payload = { membership_plan_id: membershipPlanId };
  for (const field of MEMBER_FIELDS) payload[field] = student[field];
  let last = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    last = await client.post('members', payload);

    const check = await findCreatedContact({ client, student });
    if (check.state === 'found') return { ok: true, contactKey: check.contactKey };
    if (check.state === 'ambiguous' || check.state === 'error') {
      return {
        ok: false,
        reason: check.state === 'ambiguous' ? 'contact-ambiguous' : 'contact-unverified',
        message: check.message,
        // The create may well have landed. Saying otherwise would be a guess
        // about a record nobody can delete.
        mayHaveWritten: true,
      };
    }

    if (!isRetryable(last)) break;
    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_BACKOFF_MS);
  }

  return {
    ok: false,
    reason: last.ok ? 'contact-unverified' : upstreamReason(last),
    message: last.ok
      ? 'Clubworx accepted the contact but a re-read cannot find it, so it is not safe to ' +
        'book against or to create again'
      : upstreamMessage(last),
    upstreamStatus: last.status,
    mayHaveWritten: !last.ok && isRetryable(last),
  };
}

/** Read the pass a matched student holds, and judge it against the last session. */
async function readPass({ client, contactKey, membershipPlanId, lastSession, today }) {
  const res = await client.get('memberships', { contact_key: contactKey });

  if (!res.ok) {
    return {
      ok: false,
      reason: upstreamReason(res),
      message: upstreamMessage(res),
      upstreamStatus: res.status,
    };
  }

  const summary = summariseMemberships(res.body, membershipPlanId, { on: today });
  if (summary.notAnArray) {
    return {
      ok: false,
      reason: 'upstream-error',
      message: `memberships answered ${res.status} with a body that is not a list`,
      upstreamStatus: res.status,
    };
  }

  return { ok: true, verdict: assessPass({ states: summary.planStates, lastSession, on: today }) };
}

/**
 * Grant a School Pass, then prove it covers the term.
 *
 * Form-encoded — measured on `POST /memberships` (#60). Verified the same way
 * the create is: by re-reading and re-judging, because a 200 on a grant that
 * produced a pass expiring mid-term looks exactly like a 200 on one that did
 * not.
 */
async function grantPass({ client, contactKey, membershipPlanId, lastSession, today, sleep }) {
  let last = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    last = await client.postForm('memberships', {
      contact_key: contactKey,
      membership_plan_id: String(membershipPlanId),
      // Clubworx chooses today anyway (#63) — sending it makes the record say
      // what this tool intended rather than what it inherited.
      start_date: today,
    });

    const check = await readPass({ client, contactKey, membershipPlanId, lastSession, today });
    if (check.ok && check.verdict.state === 'covering') {
      return { ok: true, verdict: check.verdict };
    }
    if (!check.ok) {
      return {
        ok: false,
        reason: 'pass-unverified',
        message:
          'the School Pass was sent but could not be re-read, so whether it landed is unknown: ' +
          (check.message ?? `HTTP ${check.upstreamStatus}`),
        mayHaveWritten: true,
      };
    }
    // Read cleanly, and the pass still does not cover the term.
    if (!isRetryable(last)) {
      return {
        ok: false,
        reason: 'pass-unverified',
        message:
          'the School Pass was accepted but re-reading it shows it does not cover the last ' +
          `selected session: ${check.verdict.detail}`,
        mayHaveWritten: true,
        verdict: check.verdict,
      };
    }
    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_BACKOFF_MS);
  }

  return {
    ok: false,
    reason: 'pass-unverified',
    message: upstreamMessage(last),
    upstreamStatus: last.status,
    mayHaveWritten: true,
  };
}

/**
 * Book one event, retrying only what D8 allows.
 *
 * A booking retry is safe in a way a contact retry is not: Clubworx refuses its
 * own duplicate with *"Woops! You've already booked into this class!"*, which
 * this reads as a success. That is the idempotency guarantee, and it is also
 * why D5's whole recovery story is "re-run it".
 */
async function bookWithRetry({ client, contactKey, event, sleep }) {
  let row = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    row = await bookEvent({
      client,
      contactKey,
      eventId: event.event_id,
      spacesAvailable: event.spaces_available ?? null,
    });
    if (row.state !== FAILED || !row.retryable) break;
    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_BACKOFF_MS);
  }
  return row;
}

/** The instant an event starts, or null if it is not readable as one. */
const startOf = event => {
  const raw = event?.starts_at ?? event?.event_start_at ?? null;
  const at = raw === null ? NaN : Date.parse(raw);
  return Number.isNaN(at) ? null : at;
};

/**
 * The acknowledged event ids, as a set that can be asked about an event id.
 *
 * Compared as strings on both sides. A Clubworx event id arrives as a number
 * from the picker's read and as whatever JSON carried it on the way back in,
 * and an acknowledgement that silently stops matching because one side is
 * `101` and the other `"101"` fails in the direction that books nothing and
 * explains nothing — the operator is told the session they just vouched for is
 * refused.
 *
 * Anything that is not a list becomes an empty one rather than throwing. The
 * route already coerces a malformed body field, so this is the second guard
 * on a value that decides whether a permanent write happens — and the chain is
 * exported and called directly, by the tests here and by anything later. The
 * failure it forecloses is the one this file's header warns about: a value
 * guessed past is the one that writes. Empty is the fail-closed answer, since
 * an empty set excuses nothing.
 *
 * @param {unknown} ids
 * @returns {Set<string>}
 */
const acknowledgedSet = ids =>
  new Set(
    (Array.isArray(ids) ? ids : [])
      .filter(id => id !== null && id !== undefined)
      .map(id => String(id)),
  );

/**
 * Run the whole chain for one student.
 *
 * @param {object} opts
 * @param {object} opts.client A `createClubworxClient` instance. Everything is paced.
 * @param {{first_name: string, last_name: string, dob: string, email: string}} opts.student
 * @param {string|null} opts.contactKey Null means `new` — this call creates the contact.
 * @param {string|number} opts.membershipPlanId The School Pass plan, resolved by `GET /plan`.
 * @param {string} opts.membershipDuration The plan's `membership_duration`, raw.
 * @param {Array<{event_id: any, starts_at: string, spaces_available?: number}>} opts.events
 * @param {Array<any>} [opts.leadTimeAcknowledgedEventIds] The event ids the operator
 *   has stated they lifted the Clubworx booking restriction for (ADR 0007). A list,
 *   never a flag: everything absent from it is still refused by the gate below.
 * @param {string} [opts.now] The instant of the run. Injected so tests are not clock-dependent.
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 */
export async function runStudentChain({
  client: rawClient,
  student,
  contactKey = null,
  membershipPlanId,
  membershipDuration,
  events = [],
  leadTimeAcknowledgedEventIds = [],
  now = new Date().toISOString(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
}) {
  const { client, state } = countedClient(rawClient);
  const warnings = [];

  const result = over => ({
    ok: false,
    outcome: 'failed',
    written: false,
    contact: { contact_key: contactKey, state: contactKey ? 'matched' : null },
    pass: { state: null, expiration_date: null, detail: null },
    bookings: [],
    rollback: null,
    stranded: false,
    strandedDetail: null,
    warnings,
    requests: state.requests,
    reason: null,
    message: null,
    ...over,
  });

  // -------------------------------------------------------------------------
  // Gates. Everything here runs before a single request, because after the
  // first write there is no way back.
  // -------------------------------------------------------------------------
  const startedAt = Date.parse(now);
  const today = perthDay(now);
  if (Number.isNaN(startedAt) || !today) {
    return result({ outcome: 'refused', reason: 'bad-request', message: 'the run time is not a readable instant' });
  }

  if (!student?.first_name || !student?.last_name || !isRealDay(student?.dob) || !student?.email) {
    return result({
      outcome: 'refused',
      reason: 'bad-request',
      message: 'a student needs a first name, a last name, an email and a YYYY-MM-DD date of birth',
    });
  }

  if (!membershipPlanId) {
    return result({
      outcome: 'refused',
      reason: 'bad-request',
      message: 'the School Pass plan id is required; a run without it cannot grant a pass',
    });
  }

  if (!Array.isArray(events) || events.length === 0) {
    return result({ outcome: 'refused', reason: 'bad-request', message: 'no sessions were selected' });
  }

  const starts = events.map(startOf);
  if (starts.some(at => at === null) || events.some(e => e?.event_id === undefined || e?.event_id === null)) {
    return result({
      outcome: 'refused',
      reason: 'bad-request',
      message:
        'every session needs an event id and a readable start time — a session whose start ' +
        'cannot be read cannot be checked against the lead time',
    });
  }

  // ADR 0007 — the gate is NARROWED to the sessions nobody acknowledged, never
  // switched off. A single "allow too-soon" flag was rejected because it would
  // also cover a session that crossed into the lead time between selection and
  // this call, and a session the operator never saw. Both are real on a
  // sixty-student list started late in the evening, and under a flag both book
  // silently. The acknowledgement is read here and nowhere else: the rule
  // itself still lives once, in `events.js`, and is imported above.
  //
  // **Only a session that has not started yet can be excused.** ADR 0007 keeps
  // an already-started session a hard-stop — it is not a restriction the gym
  // can lift, so no confirmation can buy it. This gate has no separate
  // past-session check (the page's `sessionRefusal()` does): a started session
  // arrives here as a NEGATIVE delta and is caught by the same comparison. So
  // the exclusion has to be written down here, or the same late-evening list
  // the ids exist to protect books a session that is already under way.
  //
  // Note what this deliberately does NOT do: it does not give a started
  // session its own reason. Nothing about a request carrying no
  // acknowledgements may move, and today such a session refuses as
  // `lead-time`.
  const acknowledged = acknowledgedSet(leadTimeAcknowledgedEventIds);
  const excused = (event, at) => at > startedAt && acknowledged.has(String(event.event_id));
  const tooSoon = events.filter(
    (e, i) => starts[i] - startedAt < MIN_LEAD_HOURS * MS_PER_HOUR && !excused(e, starts[i]),
  );
  if (tooSoon.length > 0) {
    // D9 — dropping the event automatically was rejected as a silent
    // adjustment. Staff must never meet Clubworx's own message here.
    return result({
      outcome: 'refused',
      reason: 'lead-time',
      message:
        `${tooSoon.length} selected session(s) start within ${MIN_LEAD_HOURS} hours. ` +
        'Clubworx refuses those, with a message that reads like a capacity problem. ' +
        'Remove them and run again.',
      leadTimeEventIds: tooSoon.map(e => e.event_id),
    });
  }

  const lastSession = perthDay(new Date(Math.max(...starts)));

  const duration = parsePlanDuration(membershipDuration);
  if (!duration.ok) {
    // §11: warn on screen naming the raw value. Never skip the coverage check
    // silently — a plan whose duration is later shortened must produce a visible
    // refusal, not a quiet tail of missing bookings.
    warnings.push(
      `The School Pass plan reports its duration as ${JSON.stringify(duration.raw)}, which this ` +
        'tool cannot read. The pass-coverage check has been skipped, so nothing here has ' +
        'confirmed that the pass reaches the last selected session.',
    );
  } else {
    const coversTo = passCoverageEnd(today, duration);
    if (!coversTo || lastSession > coversTo) {
      return result({
        outcome: 'refused',
        reason: 'pass-coverage',
        message:
          `A School Pass granted today runs ${duration.raw} and covers to ${coversTo}, but the ` +
          `last selected session is ${lastSession}. Every booking would be written on a day the ` +
          'pass is active and the last sessions would fail weeks later. Nothing has been written.',
        coversTo,
        lastSession,
      });
    }
  }

  // -------------------------------------------------------------------------
  // The pass. Two shapes, per D4.
  // -------------------------------------------------------------------------
  let key = contactKey;
  let contactState = contactKey ? 'matched' : 'created';
  let pass = { state: null, expiration_date: null, detail: null };
  let passAssured = false;

  if (!key) {
    const created = await createContactWithPass({ client, student, membershipPlanId, sleep });
    if (!created.ok) {
      return result({
        outcome: 'failed',
        reason: created.reason,
        message: created.message,
        written: created.mayHaveWritten === true,
        contact: { contact_key: null, state: null },
        // A contact that may exist with a pass and no bookings is exactly the
        // stranded shape, and it is the case a human has to resolve by hand.
        stranded: created.mayHaveWritten === true,
        strandedDetail:
          created.mayHaveWritten === true
            ? 'A contact may have been created for this student, with a School Pass and no ' +
              'bookings. Contacts cannot be deleted through the API — check Clubworx before ' +
              're-running this student.'
            : null,
      });
    }

    key = created.contactKey;
    // D4: no membership read for a contact we just created. It provably held
    // none, and the pass rode along on the create — one request that either
    // happened or did not (#63), which the contact re-read has just confirmed.
    pass = {
      state: 'created-with-contact',
      expiration_date: null,
      detail: 'created with the contact, in one request, starting today',
    };
    passAssured = true;
  } else {
    // D14 — read immediately before the write it guards, not at preview.
    const held = await readPass({ client, contactKey: key, membershipPlanId, lastSession, today });
    if (!held.ok) {
      return result({
        outcome: 'failed',
        reason: held.reason,
        message: held.message,
        // Nothing written: the read is the first thing the matched branch does.
        written: false,
      });
    }

    const verdict = held.verdict;
    pass = {
      state: verdict.state,
      expiration_date: verdict.expirationDate,
      detail: verdict.detail,
    };

    if (verdict.state === 'needs-confirmation' || verdict.state === 'unknown') {
      // §11's posture, and #90's open question: granting a second pass to a live
      // holder has never been tested and memberships have no delete.
      return result({
        outcome: 'needs-confirmation',
        reason: verdict.state === 'unknown' ? 'pass-indeterminate' : 'pass-not-covering',
        message: verdict.detail,
        contact: { contact_key: key, state: 'matched' },
        pass,
        written: false,
      });
    }

    if (verdict.grant) {
      const granted = await grantPass({
        client,
        contactKey: key,
        membershipPlanId,
        lastSession,
        today,
        sleep,
      });
      if (!granted.ok) {
        return result({
          outcome: 'failed',
          reason: granted.reason,
          message: granted.message,
          written: granted.mayHaveWritten === true,
          contact: { contact_key: key, state: 'matched' },
          pass: { ...pass, state: 'grant-failed' },
          stranded: granted.mayHaveWritten === true,
          strandedDetail:
            granted.mayHaveWritten === true
              ? 'A School Pass may have been assigned to this student, with no bookings. ' +
                'Memberships cannot be deleted through the API — check Clubworx before re-running.'
              : null,
        });
      }
      pass = {
        state: 'granted',
        expiration_date: granted.verdict.expirationDate,
        detail: granted.verdict.detail,
      };
    }
    passAssured = true;
  }

  // -------------------------------------------------------------------------
  // The bookings, and D3's rollback.
  // -------------------------------------------------------------------------
  const rows = [];
  let failure = null;

  for (const event of events) {
    const row = await bookWithRetry({ client, contactKey: key, event, sleep });
    rows.push(row);
    if (row.state !== BOOKED && row.state !== ALREADY_BOOKED_STATE) {
      failure = row;
      break;
    }
  }

  const abandon = async ({ reason, message }) => {
    // The same code path as the human "Cancel bookings from this run" control,
    // with no human present — so it honours the same interlock: act on `booked`,
    // never on `already booked`.
    const rollback = await cancelRunBookings({ client, contactKey: key, rows });
    // A cancel Clubworx accepted and did not apply leaves a booking behind just
    // as surely as one it refused, so `stillBooked` counts toward the leftover
    // rather than being reported separately. The re-read is what finds them.
    const leftover = rollback.failed.length + rollback.stillBooked.length;
    // Cancels were sent and nothing here knows whether they took — a throttled
    // or truncated verifying read. Saying "no bookings from this run" on the
    // strength of that would be the 200 being trusted all over again.
    const unconfirmed = rollback.cancelled > 0 && !rollback.verified;

    return result({
      outcome: 'abandoned',
      reason,
      message,
      written: true,
      contact: { contact_key: key, state: contactState },
      pass,
      bookings: rows,
      rollback,
      stranded: passAssured,
      strandedDetail: passAssured
        ? 'This student has a contact and a School Pass and no bookings from this run' +
          (leftover > 0
            ? `, and ${leftover} booking(s) could not be cancelled — they need removing by hand.`
            : unconfirmed
              ? ', as far as can be told — the cancellations were accepted but could not be ' +
                'confirmed by re-reading. Check this student in Clubworx.'
              : '. Finish them by hand, or fix the session and run the list again.')
        : null,
      requests: state.requests,
    });
  };

  if (failure) {
    return abandon({
      reason: failure.reason ?? failure.refusal ?? 'booking-refused',
      message: failure.shown ?? failure.message ?? 'a booking failed',
    });
  }

  // -------------------------------------------------------------------------
  // Verify by re-reading, never by the status code.
  // -------------------------------------------------------------------------
  const held = await readBookings({ client, contactKey: key });

  if (!held.ok) {
    // Nothing is rolled back here on purpose. A failed *read* is not a failed
    // write, and cancelling good bookings because a verification request
    // timed out would destroy the very thing being checked. The row set is
    // handed back so the human control can act on it.
    return result({
      ok: false,
      outcome: 'unverified',
      reason: 'bookings-unread',
      message:
        'every booking was accepted but they could not be re-read to confirm: ' +
        (held.message ?? `HTTP ${held.upstreamStatus}`) +
        '. Nothing has been cancelled — check this student in Clubworx.',
      written: true,
      contact: { contact_key: key, state: contactState },
      pass,
      bookings: rows,
      requests: state.requests,
    });
  }

  const heldEvents = new Set(held.eventIds);
  const missing = rows.filter(row => !heldEvents.has(String(row.event_id)));
  if (missing.length > 0) {
    return abandon({
      reason: 'bookings-unverified',
      message:
        `${missing.length} session(s) were accepted by Clubworx but are not there on a re-read. ` +
        'A booking that reports success and does not exist is the one failure a status code ' +
        'cannot show, so this student has been rolled back rather than reported as done.',
    });
  }

  return result({
    ok: true,
    outcome: 'complete',
    written: true,
    contact: { contact_key: key, state: contactState },
    pass,
    bookings: rows,
    stranded: false,
    requests: state.requests,
  });
}
