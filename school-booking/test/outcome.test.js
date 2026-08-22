// What a `POST /student` answer means, in the words the result table uses.
//
// The engine (`run.js`) decides *when* to call; this file is about what comes
// back. Two of its jobs are safety-critical rather than cosmetic:
//
//   - **`isFailure`** feeds D7's circuit breaker. Counting a `needs-confirmation`
//     as a failure would halt a run on three students who merely hold a pass
//     that does not cover the term — a routine outcome, not a systemic one.
//   - **`cancellable`** is the interlock. A row marked `already booked` was NOT
//     made by this run, and cancelling it deletes a booking a real member may
//     have made themselves (#50's worst outcome). The Worker enforces this too;
//     the page must not send those rows anyway.

import { describe, expect, test } from 'vitest';
import {
  cancelReport,
  cancelRows,
  cancellable,
  bookingRows,
  isFailure,
  cancellableStudents,
  notRunRecord,
  progressLine,
  resultLine,
  resultTotals,
  runRecordText,
  settledRun,
  strandedWarning,
  successLine,
  studentRecord,
} from '../outcome.js';

const student = (over = {}) => ({
  key: 1,
  name: 'Ada Lovelace',
  dob: '2010-12-10',
  firstName: 'Ada',
  lastName: 'Lovelace',
  contactKey: null,
  sessions: 2,
  ...over,
});

const booking = (over = {}) => ({
  event_id: 'e1',
  state: 'booked',
  booking_id: 'b1',
  bookingId: 'b1',
  refusal: null,
  message: null,
  shown: null,
  ...over,
});

/** A `complete` answer for a student this run created. */
const complete = (over = {}) => ({
  ok: true,
  outcome: 'complete',
  written: true,
  contact: { contact_key: 'c1', state: 'created' },
  pass: { state: 'created-with-contact', expiration_date: null, detail: 'created with the contact' },
  bookings: [booking(), booking({ event_id: 'e2', booking_id: 'b2', bookingId: 'b2' })],
  rollback: null,
  stranded: false,
  strandedDetail: null,
  warnings: [],
  requests: 5,
  reason: null,
  message: null,
  ...over,
});

const record = (studentOver, body, status = 200) =>
  studentRecord({ student: student(studentOver), status, body });

describe('studentRecord — the three permanence classes stay apart', () => {
  test('a created student counts a contact, a pass and its bookings', () => {
    const row = record({}, complete());
    expect(row.state).toBe('booked');
    expect(row.contactCreated).toBe(true);
    expect(row.passGranted).toBe(true);
    expect(row.booked).toBe(2);
    expect(row.alreadyBooked).toBe(0);
    expect(row.contactKey).toBe('c1');
  });

  test('a returning student granted a pass counts the pass and no contact', () => {
    const row = record(
      { contactKey: 'c9' },
      complete({
        contact: { contact_key: 'c9', state: 'matched' },
        pass: { state: 'granted', expiration_date: '2027-02-18', detail: '26 weeks' },
      }),
    );
    expect(row.contactCreated).toBe(false);
    expect(row.passGranted).toBe(true);
  });

  test('a returning student who already held a covering pass counts neither', () => {
    const row = record(
      { contactKey: 'c9' },
      complete({
        contact: { contact_key: 'c9', state: 'matched' },
        pass: { state: 'covering', expiration_date: '2027-01-01', detail: 'already covers' },
      }),
    );
    expect(row.contactCreated).toBe(false);
    expect(row.passGranted).toBe(false);
    expect(row.state).toBe('booked');
  });

  test('every booking already there reads as `already booked`, never as an error', () => {
    const row = record(
      { contactKey: 'c9' },
      complete({
        contact: { contact_key: 'c9', state: 'matched' },
        pass: { state: 'covering', expiration_date: null, detail: null },
        bookings: [
          booking({ state: 'already booked', booking_id: null, bookingId: null }),
          booking({ event_id: 'e2', state: 'already booked', booking_id: null, bookingId: null }),
        ],
      }),
    );
    expect(row.state).toBe('already booked');
    expect(row.alreadyBooked).toBe(2);
    expect(row.booked).toBe(0);
    expect(isFailure(row)).toBe(false);
  });
});

describe('studentRecord — the outcomes that are not success', () => {
  test('an abandoned student with a pass is named stranded, with the detail carried', () => {
    const row = record({}, {
      ...complete(),
      ok: false,
      outcome: 'abandoned',
      reason: 'booking-refused',
      message: 'Sorry, this class has no free spaces available.',
      stranded: true,
      strandedDetail: 'This student has a contact and a School Pass and no bookings from this run.',
      rollback: { cancelled: 1, failed: [], stillBooked: [], verified: true, skipped: 0 },
    });
    expect(row.state).toBe('stranded');
    expect(row.stranded).toBe(true);
    expect(row.detail).toContain('no free spaces');
    expect(isFailure(row)).toBe(true);
  });

  test('a non-covering pass is a row that needs a human, and does not feed the breaker', () => {
    const row = record({ contactKey: 'c9' }, {
      ...complete(),
      ok: false,
      outcome: 'needs-confirmation',
      reason: 'pass-not-covering',
      message: 'the held pass runs out before the last session',
      written: false,
      bookings: [],
      pass: { state: 'needs-confirmation', expiration_date: '2026-09-30', detail: 'runs out first' },
    });
    expect(row.state).toBe('needs you');
    expect(row.passGranted).toBe(false);
    expect(isFailure(row)).toBe(false);
  });

  test('a refusal before any write is `refused` and nothing is counted', () => {
    const row = studentRecord({
      student: student(),
      status: 400,
      body: { outcome: 'refused', reason: 'lead-time', message: 'a session starts within 24 hours', written: false },
    });
    expect(row.state).toBe('refused');
    expect(row.written).toBe(false);
    expect(row.contactCreated).toBe(false);
    expect(isFailure(row)).toBe(true);
  });

  test('`unverified` says go and look, and is not a synonym for failed', () => {
    const row = record({}, {
      ...complete(),
      ok: false,
      outcome: 'unverified',
      reason: 'bookings-unread',
      message: 'every booking was accepted but they could not be re-read to confirm',
    });
    expect(row.state).toBe('unverified');
    expect(row.detail).toContain('could not be re-read');
    // Bookings were accepted, so they are still this run's to cancel.
    expect(cancellable(row)).toHaveLength(2);
  });

  test('a throttle that wrote nothing is `not run`, and the student can be re-run', () => {
    const row = studentRecord({
      student: student(),
      status: 429,
      body: { outcome: 'failed', reason: 'throttled', message: 'Clubworx is busy', written: false },
    });
    expect(row.state).toBe('not run');
    expect(row.throttled).toBe(true);
    expect(row.written).toBe(false);
  });

  test('a network error names itself rather than borrowing an outcome', () => {
    const row = studentRecord({ student: student(), error: 'Failed to fetch' });
    expect(row.state).toBe('failed');
    expect(row.outcome).toBe('network');
    expect(row.detail).toContain('Failed to fetch');
    expect(row.written).toBe(false);
    expect(isFailure(row)).toBe(true);
  });

  test('an unknown Clubworx message travels verbatim and is never re-worded', () => {
    const row = record({}, {
      ...complete(),
      ok: false,
      outcome: 'failed',
      reason: 'unknown',
      message: 'Sorry! Something entirely new happened.',
      bookings: [booking({ state: 'failed', booking_id: null, bookingId: null, shown: 'Sorry! Something entirely new happened.' })],
    });
    expect(row.detail).toContain('Sorry! Something entirely new happened.');
  });
});

describe('cancellable — the interlock', () => {
  test('it takes rows this run booked and never one that was already there', () => {
    const row = record({}, complete({
      bookings: [
        booking(),
        booking({ event_id: 'e2', state: 'already booked', booking_id: null, bookingId: null }),
        booking({ event_id: 'e3', booking_id: 'b3', bookingId: 'b3' }),
      ],
    }));
    expect(cancellable(row).map((b) => b.booking_id)).toEqual(['b1', 'b3']);
  });

  test('a booked row with no id is not cancellable — there is nothing to send', () => {
    const row = record({}, complete({ bookings: [booking({ booking_id: null, bookingId: null })] }));
    expect(cancellable(row)).toEqual([]);
  });

  test('a row already cancelled is not offered a second time', () => {
    const row = record({}, complete());
    const cancelled = { ...row, cancel: { outcome: 'cancelled', cancelledIds: ['b1', 'b2'] } };
    expect(cancellable(cancelled)).toEqual([]);
  });

  test('a partial cancel leaves the bookings that are still there', () => {
    const row = record({}, complete());
    const partial = { ...row, cancel: { outcome: 'partial', cancelledIds: ['b1'] } };
    expect(cancellable(partial).map((b) => b.booking_id)).toEqual(['b2']);
  });
});

describe('the summary — D11, the permanence line in past tense', () => {
  const rows = () => [
    record({ key: 1 }, complete()),
    record({ key: 2, name: 'Grace Hopper' }, complete({
      contact: { contact_key: 'c2', state: 'matched' },
      pass: { state: 'covering', expiration_date: null, detail: null },
      bookings: [
        booking({ state: 'already booked', booking_id: null, bookingId: null }),
        booking({ event_id: 'e2', state: 'already booked', booking_id: null, bookingId: null }),
      ],
    })),
    studentRecord({
      student: student({ key: 3, name: 'Alan Turing' }),
      status: 400,
      body: { outcome: 'refused', reason: 'lead-time', message: 'a session starts within 24 hours' },
    }),
  ];

  test('the three permanence classes are counted apart, never collapsed', () => {
    const totals = resultTotals(rows());
    expect(totals).toMatchObject({
      contacts: 1,
      passes: 1,
      bookings: 2,
      alreadyBooked: 2,
      refused: 1,
      stranded: 0,
    });
  });

  test('the line says what was made permanent, and points at the row that refused', () => {
    const line = resultLine(rows());
    expect(line).toContain('1 contact created (permanent)');
    expect(line).toContain('1 School Pass assigned (permanent)');
    expect(line).toContain('2 bookings made (can be cancelled)');
    expect(line).toContain('2 already booked');
    expect(line).toContain('1 refused');
    // The row, by its position in the table — the only number staff can find.
    expect(line).toContain('row 3');
  });

  test('a stranded student is named, because finishing them by hand is the routine case', () => {
    const stranded = record({ key: 4, name: 'Katherine Johnson' }, {
      ...complete(),
      ok: false,
      outcome: 'abandoned',
      reason: 'booking-refused',
      message: 'refused',
      stranded: true,
      strandedDetail: 'contact and pass, no bookings',
      bookings: [],
    });
    const warning = strandedWarning([...rows(), stranded]);
    expect(warning).toContain('1 student has a contact and a pass but no bookings');
    expect(warning).toContain('Katherine Johnson');
  });

  test('no stranded student means no warning at all, rather than a zero', () => {
    expect(strandedWarning(rows())).toBe('');
  });

  test('once bookings are cancelled the line stops offering to cancel them', () => {
    const [first, ...rest] = rows();
    const line = resultLine([
      { ...first, cancel: { outcome: 'cancelled', cancelled: 2, cancelledIds: ['b1', 'b2'] } },
      ...rest,
    ]);
    expect(line).toContain('2 bookings made, 2 cancelled since');
    expect(line).not.toContain('can be cancelled');
  });

  test('an empty run says nothing', () => {
    expect(resultLine([])).toBe('');
    expect(strandedWarning([])).toBe('');
  });
});

describe('the record staff keep — D10', () => {
  test('it carries the names, the outcomes and the booking ids a human would need', () => {
    const text = runRecordText([record({}, complete())], { school: 'newman', at: '2026-08-21T10:00:00+08:00' });
    expect(text).toContain('newman');
    expect(text).toContain('Ada Lovelace');
    expect(text).toContain('booked');
    expect(text).toContain('b1');
    // Parseable, so a later tool can read it rather than a human re-typing it.
    expect(() => JSON.parse(text)).not.toThrow();
  });
});

describe('cancelReport — what a human still has to do', () => {
  const withCancel = (cancel) => ({ bookings: [], cancel });

  test('no cancel yet is null, not an empty report', () => {
    // Absent and "did nothing" are different facts.
    expect(cancelReport({ bookings: [] })).toBe(null);
  });

  test('rows the Worker did not try after a throttle are kept out of the by-hand list', () => {
    const report = cancelReport(withCancel({
      outcome: 'partial',
      cancelled: 1,
      cancelledIds: ['b1'],
      verified: true,
      stillBooked: [],
      failed: [
        { booking_id: 'b2', event_id: 'e2', reason: 'refused', attempted: true },
        { booking_id: 'b3', event_id: 'e3', reason: 'not attempted — throttling', attempted: false },
      ],
    }));
    // b3 is still there and still cancellable from this page; naming it as a
    // manual job sends staff into Clubworx to do what one more click does.
    expect(report.byHand.map((f) => f.booking_id)).toEqual(['b2']);
    expect(report.notAttempted.map((f) => f.booking_id)).toEqual(['b3']);
  });

  test('a pre-send refusal has no `attempted` flag at all and still needs a hand', () => {
    const report = cancelReport(withCancel({
      cancelled: 0, cancelledIds: [], verified: false, stillBooked: [],
      failed: [{ booking_id: null, event_id: 'e1', reason: 'Clubworx returned no booking id' }],
    }));
    expect(report.byHand).toHaveLength(1);
    expect(report.notAttempted).toEqual([]);
  });

  test('an id the re-read found still present joins the by-hand list', () => {
    const report = cancelReport(withCancel({
      outcome: 'still-booked', cancelled: 2, cancelledIds: ['b1', 'b2'],
      verified: false, stillBooked: ['b2'], failed: [],
    }));
    expect(report.byHand.map((f) => f.booking_id)).toEqual(['b2']);
    expect(report.byHand[0].reason).toContain('still there on a re-read');
  });

  test('unverified is reported as unverified, not as failed', () => {
    const report = cancelReport(withCancel({
      outcome: 'unverified', cancelled: 2, cancelledIds: ['b1', 'b2'],
      verified: false, stillBooked: [], failed: [],
    }));
    expect(report.verified).toBe(false);
    expect(report.byHand).toEqual([]);
    expect(report.cancelled).toBe(2);
  });
});

describe('D3’s rollback is already a cancel — the interlock has to see it', () => {
  // `abandon()` in the Worker hands back the booking rows UNMUTATED: they still
  // read `state: 'booked'` and still carry their ids, and what actually
  // happened to them is in `rollback.cancelledIds`. Reading only `cancel`
  // offers to cancel bookings the Worker already cancelled — on the very rows
  // whose own `strandedDetail` says the student has no bookings from this run.
  const abandoned = (over = {}) => record({}, {
    ...complete(),
    ok: false,
    outcome: 'abandoned',
    reason: 'booking-refused',
    message: 'Sorry, this class has no free spaces available.',
    stranded: true,
    strandedDetail: 'This student has a contact and a School Pass and no bookings from this run.',
    rollback: { cancelled: 2, cancelledIds: ['b1', 'b2'], failed: [], stillBooked: [], verified: true, skipped: 0 },
    ...over,
  });

  test('a rolled-back booking is not offered for cancelling', () => {
    expect(cancellable(abandoned())).toEqual([]);
  });

  test('and is not re-sent to the unbook route', () => {
    expect(cancelRows(abandoned())).toEqual([]);
  });

  test('a rollback that could only cancel one leaves the other cancellable', () => {
    const partial = abandoned({
      rollback: { cancelled: 1, cancelledIds: ['b1'], failed: [{ booking_id: 'b2', attempted: true, reason: 'refused' }], stillBooked: [], verified: true, skipped: 0 },
    });
    expect(cancellable(partial).map((b) => b.booking_id)).toEqual(['b2']);
  });

  test('the row does not count bookings the rollback removed as ones staff can cancel', () => {
    const row = abandoned();
    expect(row.booked).toBe(0);
    expect(row.rolledBack).toBe(2);
    // Otherwise the table says "2 bookings made (can be cancelled)" beside a
    // detail line saying the student has none.
    expect(resultTotals([row])).toMatchObject({ bookings: 0, rolledBack: 2 });
  });

  test('the summary accounts for them rather than just showing a lower total', () => {
    expect(resultLine([abandoned()])).toContain('2 bookings rolled back');
  });

  test('the bookings list says `rolled back`, not `booked`, beside a dead id', () => {
    // A row still reading `booked` sends a human into Clubworx hunting for a
    // booking that is not there.
    expect(bookingRows(abandoned()).map((b) => b.state)).toEqual(['rolled back', 'rolled back']);
  });

  test('a human cancel marks its own rows too', () => {
    const done = { ...record({}, complete()), cancel: { outcome: 'cancelled', cancelled: 1, cancelledIds: ['b1'] } };
    expect(bookingRows(done).map((b) => b.state)).toEqual(['cancelled', 'booked']);
  });

  test('an already-booked row is never relabelled — it was never this run’s', () => {
    const row = record({}, complete({
      bookings: [booking({ state: 'already booked', booking_id: null, bookingId: null })],
      rollback: { cancelled: 0, cancelledIds: [], failed: [], stillBooked: [], verified: false, skipped: 1 },
    }));
    expect(bookingRows(row).map((b) => b.state)).toEqual(['already booked']);
  });
});

describe('notRunRecord — the students a halt never reached', () => {
  test('it is a real row with nothing written', () => {
    const row = notRunRecord(student({ key: 9, name: 'Alan Turing' }), 'The run stopped first.');
    expect(row.state).toBe('not run');
    expect(row.name).toBe('Alan Turing');
    expect(row.written).toBe(false);
    expect(isFailure(row)).toBe(true);
    expect(cancellable(row)).toEqual([]);
  });

  test('it is counted as not run and never as a failure staff must chase', () => {
    const rows = [record({}, complete()), notRunRecord(student({ key: 2 }), 'stopped')];
    expect(resultTotals(rows)).toMatchObject({ notRun: 1, failed: 0, stranded: 0 });
    expect(resultLine(rows)).toContain('1 not run');
  });
});

// #111 — the predicate that keeps the already-run gate off D5's recovery path.
//
// This is the half of #111 with the dangerous failure mode. The gate BLOCKS
// rather than warns, so a run wrongly called settled leaves the operator with
// no route to the re-run §12 D5 prescribes and no control anywhere that clears
// it. Everything here errs toward "not settled", which merely re-offers Apply.
describe('settledRun — did this run leave anything worth doing again?', () => {
  test('a clean complete run is settled', () => {
    expect(settledRun('complete', [record({}, complete())])).toBe(true);
  });

  test('a halt is never settled, however clean the students it did reach', () => {
    // Every student it tried succeeded; the ones it never tried are the point.
    expect(settledRun('halted', [record({}, complete())])).toBe(false);
  });

  test('a stranded student keeps it open — D3 rolled their bookings back', () => {
    const stranded = record({}, complete({ outcome: 'failed', stranded: true, strandedDetail: 'no bookings' }));
    expect(settledRun('complete', [record({}, complete()), stranded])).toBe(false);
  });

  test('an outright failure keeps it open', () => {
    expect(settledRun('complete', [record({}, complete({ outcome: 'failed', ok: false }))])).toBe(false);
  });

  test('a refusal does not keep it open — re-running reproduces it exactly', () => {
    // A session inside its lead time or a pass that will not cover the term is
    // a standing condition of the run, not a transient failure. The fix is to
    // change something, and changing something re-opens the gate anyway.
    const refused = record({}, complete({ ok: false, outcome: 'refused', written: false, reason: 'lead-time' }));
    expect(settledRun('complete', [refused])).toBe(true);
  });

  test('an empty run is not a settled one', () => {
    expect(settledRun('halted', [])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #112 — the line that says the run is alive
// ---------------------------------------------------------------------------
// Display only. It reads two numbers the run already has and never touches what
// the run does. It lives here rather than inline in the page because the page's
// own copy of it was two template literals with a plural rule in each, which is
// the shape that quietly says "1 students".

describe('progressLine (#112)', () => {
  test('a run with nothing in it has nothing to say', () => {
    expect(progressLine({ done: 0, total: 0 })).toBe('');
    expect(progressLine()).toBe('');
  });

  test('before the first student lands it names the size of what was started', () => {
    expect(progressLine({ done: 0, total: 6 })).toBe('Starting 6 students…');
  });

  test('one student is one student', () => {
    expect(progressLine({ done: 0, total: 1 })).toBe('Starting 1 student…');
  });

  test('mid-run it is a position in the list, not a percentage', () => {
    // A count staff can check against the table under it. A percentage is a
    // number with nothing on screen to reconcile it against.
    expect(progressLine({ done: 3, total: 6 })).toBe('3 of 6 students done…');
  });

  test('the last student still reads as in-flight — the run has not returned yet', () => {
    // `onRow` fires before the engine decides whether to halt, so `6 of 6` is a
    // real state and briefly on screen. The banner is cleared by the run
    // ending, not by this line.
    expect(progressLine({ done: 6, total: 6 })).toBe('6 of 6 students done…');
  });
});

describe('cancellableStudents (#112)', () => {
  // The cancel loop SKIPS a record with nothing this run booked, so the
  // denominator of its progress is not the row count. This has to agree with
  // run.js's own `cancellable(record).length === 0 → continue`, or the counter
  // stops short of its own total and reads as a stall.
  const booked = () => record({}, complete());

  test('a run nothing was booked in has nobody to send', () => {
    expect(cancellableStudents([])).toBe(0);
    expect(cancellableStudents()).toBe(0);
  });

  test('it counts students, not bookings — one call per student is the shape', () => {
    // Two students, two bookings each: four bookings, two calls.
    expect(cancellableStudents([booked(), booked()])).toBe(2);
  });

  test('an already-booked row is not one of them — D12’s interlock', () => {
    // The booking predates this run and may be one a real member made
    // themselves. It is never sent, so it is never counted.
    const already = record({}, complete({ outcome: 'already-booked', bookings: [] }));
    expect(cancellableStudents([booked(), already])).toBe(1);
  });

  test('it agrees with anyCancellable on the empty case', () => {
    const already = record({}, complete({ outcome: 'already-booked', bookings: [] }));
    expect(cancellableStudents([already])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The success confirmation (#113)
// ---------------------------------------------------------------------------
// UAT of #74 reported the result step leading with "Cancel bookings from this
// run" and never saying, with equivalent weight, that the import worked. The
// banner that fixes that has one way to be worse than the silence it replaces:
// appearing over a run that did not work. "Successful" is not "the run ended"
// and it is not "no failures" either — a complete run can hold a refused
// student, a student whose pass needs a human, or bookings since cancelled.
describe('successLine — the confirmation, and what it refuses to confirm', () => {
  const booked = () => record({}, complete());
  const alreadyThere = () => record(
    { key: 2, contactKey: 'c9' },
    complete({
      contact: { contact_key: 'c9', state: 'matched' },
      pass: { state: 'covering', expiration_date: null, detail: null },
      bookings: [booking({ state: 'already booked', booking_id: null, bookingId: null })],
    }),
  );

  test('a run where every student ended booked is confirmed, and says how many', () => {
    const line = successLine('complete', [booked(), booked()]);
    expect(line).toContain('2 students');
    expect(line).toMatch(/booked/);
  });

  test('a student already booked before this run still counts as done', () => {
    // Nothing is left for a human: they are in the sessions, which is what the
    // operator came to achieve.
    expect(successLine('complete', [booked(), alreadyThere()])).toBeTruthy();
  });

  test('a halt is never confirmed — students were never reached', () => {
    expect(successLine('halted', [booked()])).toBe('');
  });

  test('a stranded student is never confirmed — a contact and a pass are left behind', () => {
    const stranded = record({ key: 2 }, complete({ outcome: 'abandoned', ok: false, stranded: true }));
    expect(successLine('complete', [booked(), stranded])).toBe('');
  });

  test('a refused student is never confirmed — that student got nothing', () => {
    // settledRun() deliberately calls this run settled: re-running reproduces
    // the refusal exactly, so the already-run gate should close. Being settled
    // and having worked are two different questions, and this asks the second.
    const refused = record({ key: 2 }, complete({ outcome: 'refused', ok: false, bookings: [] }));
    expect(settledRun('complete', [booked(), refused])).toBe(true);
    expect(successLine('complete', [booked(), refused])).toBe('');
  });

  test('a student whose pass needs a human is never confirmed', () => {
    const needsHuman = record({ key: 2 }, complete({ outcome: 'needs-confirmation', ok: false, bookings: [] }));
    expect(successLine('complete', [booked(), needsHuman])).toBe('');
  });

  test('bookings cancelled since take the confirmation back down', () => {
    // The bookings this line would be confirming are gone. Left up, it is the
    // sentence an operator would read to check whether the cancel worked.
    const cancelled = { ...booked(), cancel: { cancelled: 2, cancelledIds: ['b1', 'b2'], failed: [], stillBooked: [], verified: true } };
    expect(successLine('complete', [cancelled])).toBe('');
  });

  test('an empty run confirms nothing', () => {
    expect(successLine('complete', [])).toBe('');
  });

  test('a row that booked nothing at all confirms nothing', () => {
    // `display()` calls a `complete` row `already booked` whenever it booked
    // nothing, and that includes a row with no bookings of any kind. There is
    // no student in that state to point at today; the guard is here because
    // the sentence it would print — "the student is booked" — is one nothing
    // else on the page would contradict.
    const nothing = record({}, complete({ bookings: [] }));
    expect(nothing.state).toBe('already booked');
    expect(successLine('complete', [nothing])).toBe('');
  });
});
