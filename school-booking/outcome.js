// school-booking/outcome.js
//
// What one `POST /student` answer means, and what a whole run of them adds up
// to. Pure over the Worker's reply; the page publishes it as
// `window.schoolBookingOutcome`.
//
// staff-site#73. Design: `docs/superpowers/specs/2026-08-19-school-group-booking-design.md`
// §11 (the error vocabulary), §12 (irreversibility, D10, D11, D12).
//
// ---------------------------------------------------------------------------
// Why the counting is done here and not in the table
// ---------------------------------------------------------------------------
// D11 keeps the three permanence classes apart rather than collapsing them into
// a success count, because they are three different kinds of irreversible: a
// contact and a pass cannot be taken back at all, and a booking can. A single
// "58 succeeded" would be true and would hide the only distinction that matters
// when something has gone wrong.
//
// Two of the functions below are safety-critical rather than presentational:
//
//   - **`isFailure`** feeds D7's circuit breaker. A `needs-confirmation` is a
//     considered answer about one student's pass, not a systemic condition, so
//     counting it would halt a run on three ordinary rows.
//   - **`cancellable`** is D12's interlock. A row marked `already booked` was
//     not made by this run; cancelling it would delete a booking a real member
//     may have made themselves — #50's worst outcome. The Worker enforces the
//     same rule (`cancelRunBookings`), and this page does not lean on that: a
//     row it should never send is a row it does not send.

const plural = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;
const passes = (n) => `${n} School ${n === 1 ? 'Pass' : 'Passes'}`;

/** A pass state that means one was newly written, and therefore is permanent. */
const GRANTED_PASS = new Set(['created-with-contact', 'granted']);

/**
 * Outcomes that are a considered answer rather than a fault.
 *
 * Everything else feeds the circuit breaker. `refused` is in the failing set on
 * purpose: the refusals `POST /student` gives — a lead-time session, a pass that
 * will not cover the term — are conditions of the *run*, so three in a row is
 * exactly the systemic case D7 exists to stop.
 */
const SETTLED = new Set(['complete', 'needs-confirmation']);

/** Whether this row counts toward D7's three-consecutive-failures halt. */
export function isFailure(record) {
  return !SETTLED.has(record?.outcome);
}

/**
 * One student's answer, as the result table and `localStorage` both hold it.
 *
 * Takes the reply as `fetch` leaves it — a status and a parsed body — or an
 * `error` string when the request never arrived. A transport failure is named
 * `network` rather than borrowed from the outcome vocabulary: "the Worker said
 * this student failed" and "nothing reached the Worker" send an operator to two
 * different places, and only one of them may have written something.
 *
 * @param {object} opts
 * @param {object} opts.student the row being run — key, name, dob, sessions
 * @param {number|null} [opts.status] the HTTP status the Worker answered with
 * @param {object|null} [opts.body] the parsed reply
 * @param {string|null} [opts.error] set when the request itself failed
 */
export function studentRecord({ student, status = null, body = null, error = null }) {
  const base = {
    key: student?.key ?? null,
    name: student?.name ?? '',
    dob: student?.dob ?? null,
    sessions: student?.sessions ?? 0,
    contactKey: student?.contactKey ?? null,
    status,
    bookings: [],
    booked: 0,
    alreadyBooked: 0,
    contactCreated: false,
    passGranted: false,
    written: false,
    stranded: false,
    strandedDetail: null,
    rollback: null,
    warnings: [],
    throttled: false,
    // Filled by the cancel pass, and only then — an absent cancel and a cancel
    // that did nothing are different facts.
    cancel: null,
  };

  if (error !== null && error !== undefined) {
    return {
      ...base,
      outcome: 'network',
      reason: 'network',
      state: 'failed',
      label: 'failed',
      // Verbatim — D6. A paraphrase of an error nobody has seen before is how
      // new behaviour becomes invisible.
      detail: `The request did not reach Clubworx: ${error}. Nothing is known about this student — `
        + 'check Clubworx before running them again.',
    };
  }

  const reply = body ?? {};
  const outcome = reply.outcome ?? 'failed';
  const bookings = Array.isArray(reply.bookings) ? reply.bookings : [];
  const booked = bookings.filter((b) => b?.state === 'booked').length;
  const alreadyBooked = bookings.filter((b) => b?.state === 'already booked').length;
  const throttled = reply.reason === 'throttled';

  const row = {
    ...base,
    outcome,
    reason: reply.reason ?? null,
    bookings,
    booked,
    alreadyBooked,
    contactKey: reply.contact?.contact_key ?? base.contactKey,
    contactCreated: reply.contact?.state === 'created',
    passGranted: GRANTED_PASS.has(reply.pass?.state),
    written: reply.written === true,
    stranded: reply.stranded === true,
    strandedDetail: reply.strandedDetail ?? null,
    rollback: reply.rollback ?? null,
    warnings: Array.isArray(reply.warnings) ? reply.warnings : [],
    throttled,
    detail: reply.message ?? '',
  };

  // A throttle that changed nothing (the Worker's 429) is the one answer that
  // is not about this student at all — the allowance is gym-wide. Saying
  // "failed" would send staff looking at the row.
  if (throttled && row.written === false) {
    return {
      ...row,
      state: 'not run',
      label: 'not run',
      detail: 'Clubworx is busy — this can be caused by another system, not this page. '
        + 'Nothing was written for this student.',
    };
  }

  return { ...row, ...display(row) };
}

/** The cell and the sentence, from an outcome that has already been counted. */
function display(row) {
  if (row.outcome === 'complete') {
    const state = row.booked > 0 ? 'booked' : 'already booked';
    return {
      state,
      label: row.booked > 0
        ? `${plural(row.booked, 'booking')}${row.alreadyBooked > 0 ? ` · ${row.alreadyBooked} already there` : ''}`
        : `${plural(row.alreadyBooked, 'booking')} already there`,
      detail: doneLine(row),
    };
  }

  if (row.outcome === 'needs-confirmation') {
    return {
      state: 'needs you',
      label: 'needs you',
      detail: `${row.detail} Nothing has been written for this student.`,
    };
  }

  if (row.outcome === 'refused') {
    return { state: 'refused', label: 'refused', detail: row.detail || 'Refused before anything was written.' };
  }

  if (row.outcome === 'unverified') {
    return { state: 'unverified', label: 'unverified', detail: row.detail };
  }

  // `abandoned` and `failed`. Which of the two it is matters less than whether
  // a permanent record was left behind, which is what a human has to finish.
  return {
    state: row.stranded ? 'stranded' : 'failed',
    label: row.stranded ? 'stranded' : 'failed',
    detail: [row.detail, row.strandedDetail].filter(Boolean).join(' '),
  };
}

/** The past-tense sentence for one completed student. */
function doneLine(row) {
  const made = [];
  if (row.contactCreated) made.push('contact created (permanent)');
  if (row.passGranted) made.push('School Pass assigned (permanent)');
  if (row.booked > 0) made.push(`${plural(row.booked, 'booking')} made (cancellable)`);
  if (row.alreadyBooked > 0) made.push(`${plural(row.alreadyBooked, 'booking')} already there`);
  return made.join(' · ');
}

/**
 * The bookings a cancel may act on — D12's interlock.
 *
 * Three conditions, and each removes a different way of cancelling something
 * this run did not make:
 *
 *   - `state === 'booked'`, never `already booked`. The second is Clubworx
 *     refusing our duplicate, which means the booking predates this run.
 *   - a `booking_id`, because there is nothing to send without one.
 *   - not already cancelled, so a second click on the control does not re-send
 *     ids that are gone and read the refusals as a new failure.
 */
export function cancellable(record) {
  const gone = new Set((record?.cancel?.cancelledIds ?? []).map(String));
  return (record?.bookings ?? []).filter(
    (b) => b?.state === 'booked' && b?.booking_id && !gone.has(String(b.booking_id)),
  );
}

/** Whether anything in the run can still be cancelled. */
export function anyCancellable(records) {
  return (records ?? []).some((r) => cancellable(r).length > 0);
}

/** The run's tally, with the three permanence classes kept apart. */
export function resultTotals(records) {
  const rows = records ?? [];
  const totals = {
    students: rows.length,
    contacts: 0,
    passes: 0,
    bookings: 0,
    alreadyBooked: 0,
    refused: 0,
    failed: 0,
    stranded: 0,
    cancelled: 0,
    notRun: 0,
  };

  for (const row of rows) {
    if (row.contactCreated) totals.contacts += 1;
    if (row.passGranted) totals.passes += 1;
    totals.bookings += row.booked;
    totals.alreadyBooked += row.alreadyBooked;
    totals.cancelled += row.cancel?.cancelled ?? 0;
    if (row.stranded) totals.stranded += 1;
    if (row.state === 'refused') totals.refused += 1;
    if (row.state === 'not run') totals.notRun += 1;
    if (row.state === 'failed' || row.state === 'stranded' || row.state === 'unverified') totals.failed += 1;
  }

  return totals;
}

/** Row numbers, 1-based, for the states staff have to go and look at. */
const rowsWhere = (records, predicate) =>
  (records ?? [])
    .map((row, index) => (predicate(row) ? index + 1 : null))
    .filter((n) => n !== null);

/**
 * D11's summary — the same sentence the preview showed, in past tense.
 *
 * Refusals and failures are pointed at **by row number**, because that is the
 * only handle staff have on a table of 63 students, and a count with nowhere to
 * go is a count that gets ignored.
 */
export function resultLine(records) {
  const rows = records ?? [];
  if (rows.length === 0) return '';

  const t = resultTotals(rows);
  const parts = [
    `${plural(t.contacts, 'contact')} created (permanent)`,
    `${passes(t.passes)} assigned (permanent)`,
    // "can be cancelled" stops being true the moment they have been, and a
    // line that still offers the option after it was taken is the sentence
    // staff would read to check whether the cancel worked.
    t.cancelled > 0
      ? `${plural(t.bookings, 'booking')} made, ${t.cancelled} cancelled since`
      : `${plural(t.bookings, 'booking')} made (can be cancelled)`,
  ];
  if (t.alreadyBooked > 0) parts.push(`${t.alreadyBooked} already booked`);

  const refused = rowsWhere(rows, (r) => r.state === 'refused');
  if (refused.length > 0) parts.push(`${refused.length} refused — see ${rowList(refused)}`);

  const failed = rowsWhere(rows, (r) => r.state === 'failed' || r.state === 'stranded' || r.state === 'unverified');
  if (failed.length > 0) parts.push(`${failed.length} did not finish — see ${rowList(failed)}`);

  const notRun = rowsWhere(rows, (r) => r.state === 'not run');
  if (notRun.length > 0) parts.push(`${notRun.length} not run`);

  return parts.join(' · ');
}

const rowList = (numbers) =>
  numbers.length === 1 ? `row ${numbers[0]}` : `rows ${numbers.join(', ')}`;

/**
 * The stranded students, named.
 *
 * Not optional decoration: under D3's rollback an abandoned student is
 * *guaranteed* to be left with a permanent contact and pass and no bookings, so
 * this is a routine outcome staff must be able to see and finish by hand.
 */
export function strandedWarning(records) {
  const stranded = (records ?? []).filter((r) => r.stranded);
  if (stranded.length === 0) return '';
  return `⚠ ${plural(stranded.length, 'student')} ${stranded.length === 1 ? 'has' : 'have'} a contact `
    + `and a pass but no bookings: ${stranded.map((r) => r.name).join(', ')}. `
    + 'Contacts and passes cannot be deleted — finish these by hand in Clubworx.';
}

/**
 * The record staff keep — D10.
 *
 * JSON rather than prose, because the thing being defended against is a page
 * reload destroying the only record of creations that cannot be undone, and the
 * booking ids in it are what a later cancel or a hand-finish needs. It is
 * pasted into a ticket or handed back to this page; either way a human re-typing
 * a booking id is the failure this avoids.
 */
export function runRecordText(records, meta = {}) {
  return JSON.stringify(
    {
      tool: 'school-booking',
      school: meta.school ?? null,
      at: meta.at ?? null,
      sessions: meta.sessions ?? [],
      summary: resultLine(records),
      stranded: strandedWarning(records),
      students: (records ?? []).map((row) => ({
        name: row.name,
        dob: row.dob,
        contact_key: row.contactKey,
        outcome: row.outcome,
        state: row.state,
        detail: row.detail,
        contact_created: row.contactCreated,
        pass_granted: row.passGranted,
        bookings: row.bookings,
        cancel: row.cancel,
      })),
    },
    null,
    2,
  );
}
