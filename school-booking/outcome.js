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
    rolledBack: 0,
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
  // D3's rollback has already cancelled these, and the Worker hands the rows
  // back unmutated — so counting every `booked` row would report bookings that
  // no longer exist as ones staff could still cancel.
  const rolledBack = new Set((reply.rollback?.cancelledIds ?? []).map(String));
  const booked = bookings.filter(
    (b) => b?.state === 'booked' && !rolledBack.has(String(b?.booking_id)),
  ).length;
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
    rolledBack: rolledBack.size,
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
  const gone = goneIds(record);
  return (record?.bookings ?? []).filter(
    (b) => b?.state === 'booked' && b?.booking_id && !gone.has(String(b.booking_id)),
  );
}

/**
 * Every booking id that is already gone. One rule, one home.
 *
 * **Two sources, and missing the second is a bug that re-cancels.** The obvious
 * one is a previous run of the human control (`record.cancel`). The other is
 * **D3's automatic rollback**: when a student is abandoned the Worker cancels
 * that student's bookings itself and reports them in `rollback.cancelledIds` —
 * but it hands back the booking rows **unmutated**, so they still read
 * `state: 'booked'` and still carry live-looking ids. Reading only `cancel`
 * therefore offers to cancel bookings the Worker already cancelled, on exactly
 * the rows whose own `strandedDetail` says the student has *no bookings from
 * this run*.
 */
const goneIds = (record) => new Set([
  ...(record?.cancel?.cancelledIds ?? []),
  ...(record?.rollback?.cancelledIds ?? []),
].map(String));

/**
 * The bookings as they now stand, with the rows that are gone saying so.
 *
 * The Worker's row is a record of what the *booking call* did, and it is not
 * rewritten when a later cancel removes it. Rendering it raw shows `booked`
 * beside an id that no longer exists — and that id is the one a human would
 * then go looking for in Clubworx.
 */
export function bookingRows(record) {
  const gone = goneIds(record);
  const rolled = new Set((record?.rollback?.cancelledIds ?? []).map(String));
  return (record?.bookings ?? []).map((b) => {
    if (b?.state !== 'booked' || !gone.has(String(b?.booking_id))) return b;
    return { ...b, state: rolled.has(String(b.booking_id)) ? 'rolled back' : 'cancelled' };
  });
}

/**
 * The rows to send to `POST /unbook` for one student.
 *
 * The whole array `POST /student` handed back, less anything a previous cancel
 * already removed — **not** pre-filtered down to `booked`. The Worker's
 * `cancelRunBookings` owns the interlock and takes each row's own
 * `contact_key`, so handing it the rows as they came keeps one authority for
 * the rule rather than two that can drift. `cancellable` above is what decides
 * whether a student is sent at all; this is what is in the envelope.
 *
 * Dropping ids a previous pass already cancelled is a different thing: those
 * bookings are gone, and re-sending them turns a clean partial cancel into a
 * screenful of new failures.
 */
export function cancelRows(record) {
  const gone = goneIds(record);
  return (record?.bookings ?? []).filter((b) => !gone.has(String(b?.booking_id ?? '')));
}

/**
 * What a cancel left behind, split by what a human actually has to do.
 *
 * `POST /unbook` returns `failed[]` and `stillBooked[]` on a **200** on purpose:
 * a non-200 invites the page to throw the body away, and that body is the only
 * record of which bookings a human still has to remove. So they are rendered,
 * not summarised into a count.
 *
 * The split matters more than the total. `failed[].attempted === false` marks
 * rows the Worker deliberately did **not** try after a throttle — those
 * bookings are still there and still cancellable by clicking again, and listing
 * them as needing manual removal would send staff into Clubworx to do by hand
 * what one more click does. Everything else — a refused cancel, a row with no
 * booking id, and an id that came back present on the verifying re-read — is
 * genuinely a hand job.
 *
 * `verified: false` is **not** a synonym for failed. It means the cancel was
 * accepted and could not be confirmed: go and look, rather than try again.
 */
export function cancelReport(record) {
  const c = record?.cancel;
  if (!c) return null;
  const failed = Array.isArray(c.failed) ? c.failed : [];
  return {
    outcome: c.outcome ?? 'failed',
    cancelled: c.cancelled ?? 0,
    verified: c.verified === true,
    message: c.message ?? '',
    notAttempted: failed.filter((f) => f?.attempted === false),
    byHand: [
      ...failed.filter((f) => f?.attempted !== false),
      ...(c.stillBooked ?? []).map((id) => ({
        booking_id: id,
        event_id: null,
        reason: 'Clubworx accepted the cancellation and the booking was still there on a re-read',
      })),
    ],
  };
}

/**
 * The cancel's headline, in the Worker's own words.
 *
 * `message` travels verbatim — it is the Worker's sentence about a set of
 * bookings, and it already distinguishes "cancelled and confirmed gone" from
 * "accepted and could not be confirmed", which is the distinction a re-wording
 * would lose (D6).
 */
export function cancelLine(record) {
  const c = record?.cancel;
  if (!c) return '';
  const head = `${c.cancelled ?? 0} cancelled`;
  return c.message ? `${head} — ${c.message}` : head;
}

/** Whether anything in the run can still be cancelled. */
export function anyCancellable(records) {
  return (records ?? []).some((r) => cancellable(r).length > 0);
}

/**
 * How many students the cancel loop will actually call for — #112.
 *
 * Not the row count, and not the booking count either. `cancelStudents` sends
 * one call per student and SKIPS a record with nothing this run booked, so this
 * has to agree with that skip or the progress it feeds stops short of its own
 * total and reads as a stall. Same predicate, one place.
 *
 * The control above it counts *bookings* — "Cancel 12 bookings from this run" —
 * because that is the unit of what is being taken back. The loop's unit is
 * students, which is why the line it feeds says the word.
 */
export function cancellableStudents(records) {
  return (records ?? []).filter((r) => cancellable(r).length > 0).length;
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
    rolledBack: 0,
    notRun: 0,
  };

  for (const row of rows) {
    if (row.contactCreated) totals.contacts += 1;
    if (row.passGranted) totals.passes += 1;
    totals.bookings += row.booked;
    totals.alreadyBooked += row.alreadyBooked;
    totals.cancelled += row.cancel?.cancelled ?? 0;
    totals.rolledBack += row.rolledBack ?? 0;
    if (row.stranded) totals.stranded += 1;
    if (row.state === 'refused') totals.refused += 1;
    if (row.state === 'not run') totals.notRun += 1;
    if (row.state === 'failed' || row.state === 'stranded' || row.state === 'unverified') totals.failed += 1;
  }

  return totals;
}

/**
 * A student the run never reached.
 *
 * D11 is *"the same rows, same order"*, and a halt that quietly shortens the
 * table breaks the half of that which matters most: staff need to see **where
 * it got to**, and a table of 5 rows after a halt at student 5 of 25 reads as a
 * list of 5 students rather than a run that stopped. Nothing was written for
 * these, so re-running the list is how they are finished (D5).
 */
export function notRunRecord(student, detail) {
  return {
    key: student?.key ?? null,
    name: student?.name ?? '',
    dob: student?.dob ?? null,
    sessions: student?.sessions ?? 0,
    contactKey: student?.contactKey ?? null,
    status: null,
    outcome: 'not-run',
    reason: 'not-run',
    state: 'not run',
    label: 'not run',
    detail,
    bookings: [],
    booked: 0,
    alreadyBooked: 0,
    contactCreated: false,
    passGranted: false,
    written: false,
    stranded: false,
    strandedDetail: null,
    rollback: null,
    rolledBack: 0,
    warnings: [],
    throttled: false,
    cancel: null,
  };
}

/** Row numbers, 1-based, for the states staff have to go and look at. */
const rowsWhere = (records, predicate) =>
  (records ?? [])
    .map((row, index) => (predicate(row) ? index + 1 : null))
    .filter((n) => n !== null);

/**
 * Did this run leave anything worth doing again? — #111.
 *
 * This is the predicate that keeps #111's already-run gate off **D5's recovery
 * path**, and getting it wrong is how a well-meant gate becomes the thing that
 * traps an operator.
 *
 * §12 D5 makes a re-run *the* recovery: "Re-paste the same list, pick the same
 * sessions, run again." §12 D13 then refused to warn against a re-paste at all,
 * on the grounds that warning would "train staff to click through the warning
 * on the one path D5 prescribes for recovery." A gate that fires on a run with
 * a stranded student would do exactly the damage D13 named, except worse — it
 * blocks rather than warns, so there is nothing to click through.
 *
 * So the door closes only on a run that both **finished** and **left nobody
 * behind**. Two conditions, and each rules out a different kind of unfinished:
 *
 *   - **`complete`.** A run halted by D7's breaker or a throttle has students
 *     it never tried, and they are still waiting.
 *   - **No failures.** A run can reach the end and still have stranded a
 *     student — D3 rolled their bookings back and named them — or failed one
 *     outright. That is precisely what D5 says to re-run.
 *
 * A *refused* student is deliberately not counted. A refusal is a standing
 * condition of the run — a session inside its lead time, a pass that will not
 * cover the term — and running the same list again reproduces it exactly. The
 * fix is to change something, and changing something re-opens the gate anyway.
 */
export function settledRun(state, records) {
  return state === 'complete' && resultTotals(records).failed === 0;
}

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
  // Without this the bookings total simply reads lower than the run made, with
  // nothing on screen accounting for the difference. D3's rollback is a routine
  // outcome, not an edge case, so it gets a clause.
  if (t.rolledBack > 0) parts.push(`${plural(t.rolledBack, 'booking')} rolled back`);
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
 * The restrictions this run left lifted — #146, ADR 0007.
 *
 * Takes the session labels an operator **acknowledged**, not the run's records.
 * That is the whole point of the function's signature: the lifted sessions are
 * known before the first write, and a run halted by D7's breaker produces no
 * record at all for the acknowledged session — which is exactly the case where
 * a restriction is most likely to still be off. A reminder derived from results
 * would go missing precisely when it matters most.
 *
 * It is the counterpart to `strandedWarning` and sits beside it: both say *this
 * run left something for a human to finish in Clubworx*. The difference is
 * which way the failure is loud. A stranded student is visible on their own row
 * for as long as the page is open; a restriction left off is visible nowhere —
 * the class simply takes public bookings until somebody notices. So this one
 * names the stakes out loud rather than only the obligation.
 *
 * Nothing here touches Clubworx. It reminds; a person acts.
 */
export function liftedRestrictionsReminder(sessions) {
  // `filter(Boolean)` where preview.js's twin has none, and the asymmetry is
  // deliberate: that one reads labels it has just built from live events, and
  // this one reads a list that has been through `localStorage` and back. A
  // blank entry there would put a stray "; " in the middle of the one sentence
  // telling somebody a class is open to the public.
  const lifted = (sessions ?? []).filter(Boolean);
  if (lifted.length === 0) return '';

  // Semicolons — a session label carries a comma of its own, so commas here
  // would read "School Session, 2026-09-01, School Session, 2026-09-08" as four
  // things. Same rule as the preview's line (#145).
  const named = lifted.join('; ');
  const one = lifted.length === 1;

  return `⚠ ${plural(lifted.length, 'session')} ${one ? 'was' : 'were'} run with `
    + `${one ? 'its' : 'their'} Clubworx booking restriction lifted by hand: ${named}. `
    + `Put ${one ? 'it' : 'them'} back on in Clubworx — nothing here does that, and until `
    + `${one ? 'it is' : 'they are'} back on ${one ? 'the session is' : 'those sessions are'} `
    + 'open to public booking.';
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
      // #146. The obligation travels with the record: this is what staff paste
      // into a ticket, and a restriction left off outlives the page that
      // reported it. `meta.lifted` is the acknowledged session labels, taken
      // from the selection at Apply — never rebuilt from `records`.
      lifted: liftedRestrictionsReminder(meta.lifted),
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

/**
 * The in-progress line — #112.
 *
 * Display only, and deliberately made of the two numbers the run already holds:
 * how many students have come back, and how many were started. It never reads
 * the records, so it cannot be wrong about what happened — it is about whether
 * anything is still happening.
 *
 * The banner it sits in is cleared by the run *ending* (`runState` leaving
 * `running`), not by this line, which is why `done === total` still reads as
 * in-flight: `onRow` fires before the engine has decided whether to halt.
 */
export function progressLine({ done = 0, total = 0 } = {}) {
  if (total <= 0) return '';
  if (done <= 0) return `Starting ${plural(total, 'student')}…`;
  return `${done} of ${plural(total, 'student')} done…`;
}

/**
 * The confirmation, and the conditions it refuses to appear under — #113.
 *
 * UAT of #74 found the result step leading with *"Cancel bookings from this
 * run"* and never saying, with equivalent weight, that the import had worked.
 * The banner that answers that has exactly one way of being worse than the
 * silence it replaces: appearing over a run that did not work. So it is a
 * string that is empty unless the run is clean, in the same shape as
 * `strandedWarning` — the page shows the banner on the text, and there is one
 * place deciding whether there is any.
 *
 * **"Successful" is neither "the run ended" nor `settledRun`.** They answer
 * different questions and this needs the stricter one:
 *
 *   - `settledRun` asks *"is there anything worth doing again?"*, which is why
 *     it calls a run with a **refused** student settled — re-running reproduces
 *     that refusal exactly, so the already-run gate should close on it. But a
 *     refused student got nothing, and a banner saying the import worked over
 *     that row is the lie this comment exists to prevent.
 *   - A **`needs you`** row is the same: considered, not a fault, and still a
 *     student nobody has booked.
 *
 * So the test is every row, not a count: a run is confirmed only when the whole
 * table reads `booked` or `already booked`. A student already in the session
 * counts — they are booked, which is what the operator came to achieve, and
 * whether this run put them there is D11's business, not this line's.
 *
 * `cancelled > 0` takes it back down. The bookings it would be confirming are
 * gone, and a confirmation left standing after a cancel is the sentence an
 * operator would read to check whether the cancel worked.
 */
export function successLine(state, records) {
  const rows = records ?? [];
  if (state !== 'complete' || rows.length === 0) return '';
  if (!rows.every((r) => r.state === 'booked' || r.state === 'already booked')) return '';
  const t = resultTotals(rows);
  if (t.cancelled > 0) return '';
  // `display()` reads a `complete` row that booked nothing as `already
  // booked`, which includes a row holding no bookings of any kind. Nothing
  // reaches this page in that state today — a selection with no sessions
  // cannot get past step 4 — but the sentence below would be the page's only
  // word on such a row, and it would say the student is booked.
  if (t.bookings + t.alreadyBooked === 0) return '';
  return `This import is done — ${
    t.students === 1 ? 'the student is' : `all ${t.students} students are`
  } booked.`;
}
