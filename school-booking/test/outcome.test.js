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
  cancellable,
  isFailure,
  resultLine,
  resultTotals,
  runRecordText,
  strandedWarning,
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
