// The run engine, driven with a fake caller.
//
// #78's seam decision: this is a pure module taking an injected caller, not
// code inside the Alpine component, because there is no DOM test infrastructure
// in this repo and none is being added. Everything below runs when things are
// already going wrong, which is exactly the half that would otherwise have no
// automated cover at all:
//
//   - retry only on 429 / network / 5xx, and never on a 400
//   - halt after 3 consecutive failures
//   - a 429 pausing the whole run rather than one row
//   - the record written per student rather than at the end
//   - the cancel interlock, and the halt inside a cancel
//
// #51 measured the throttle failure mode as 49 successes followed by 41
// consecutive 429s. That is the case the breaker exists for and it is pinned
// below.

import { describe, expect, test, vi } from 'vitest';
import {
  FAILURE_LIMIT,
  MAX_ATTEMPTS,
  RETRY_BACKOFF_MS,
  cancelStudents,
  runList,
  runStore,
  runStudents,
} from '../run.js';

const student = (key, over = {}) => ({
  key,
  name: `Student ${key}`,
  dob: '2010-01-01',
  sessions: 2,
  contactKey: null,
  payload: { student: { first_name: 'S', last_name: String(key), dob: '2010-01-01', email: 'noreply+x@urbanjungleirc.com' } },
  ...over,
});

const booking = (over = {}) => ({
  event_id: 'e1', state: 'booked', booking_id: 'b1', bookingId: 'b1', shown: null, ...over,
});

const completeBody = (over = {}) => ({
  ok: true,
  outcome: 'complete',
  written: true,
  contact: { contact_key: 'c1', state: 'created' },
  pass: { state: 'created-with-contact' },
  bookings: [booking()],
  stranded: false,
  warnings: [],
  ...over,
});

const ok = (body) => ({ status: 200, body });
const nosleep = vi.fn(async () => {});

describe('runStudents — the ordinary path', () => {
  test('it runs one student at a time, in order, and publishes each as it lands', async () => {
    const seen = [];
    const call = vi.fn(async () => ok(completeBody()));
    const result = await runStudents({
      students: [student(1), student(2), student(3)],
      call,
      onRow: (record, records) => seen.push([record.name, records.length]),
      sleep: nosleep,
    });

    expect(result.state).toBe('complete');
    expect(result.records).toHaveLength(3);
    expect(call).toHaveBeenCalledTimes(3);
    // Published per student — D10's whole point is that the record survives a
    // reload mid-run, which an end-of-run write does not give.
    expect(seen).toEqual([['Student 1', 1], ['Student 2', 2], ['Student 3', 3]]);
  });

  test('the caller gets the payload the page built, untouched', async () => {
    const call = vi.fn(async () => ok(completeBody()));
    await runStudents({ students: [student(1)], call, sleep: nosleep });
    expect(call).toHaveBeenCalledWith(student(1).payload);
  });

  test('an empty list is a complete run, not a halt', async () => {
    const result = await runStudents({ students: [], call: vi.fn(), sleep: nosleep });
    expect(result.state).toBe('complete');
    expect(result.records).toEqual([]);
  });
});

describe('runStudents — D8, what may be retried', () => {
  test('a 429 is retried once, after the backoff floor', async () => {
    const sleep = vi.fn(async () => {});
    const call = vi.fn()
      .mockResolvedValueOnce({ status: 429, body: { outcome: 'failed', reason: 'throttled', written: false } })
      .mockResolvedValueOnce(ok(completeBody()));

    const result = await runStudents({ students: [student(1)], call, sleep });

    expect(call).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(sleep).toHaveBeenCalledWith(RETRY_BACKOFF_MS);
    expect(result.state).toBe('complete');
    expect(result.records[0].state).toBe('booked');
  });

  test('a 5xx is retried', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({ status: 502, body: { outcome: 'failed', reason: 'upstream-error', message: 'bad gateway' } })
      .mockResolvedValueOnce(ok(completeBody()));
    const result = await runStudents({ students: [student(1)], call, sleep: nosleep });
    expect(call).toHaveBeenCalledTimes(2);
    expect(result.records[0].state).toBe('booked');
  });

  test('a network error is retried, and its second failure is recorded as network', async () => {
    const call = vi.fn(async () => { throw new Error('Failed to fetch'); });
    const result = await runStudents({ students: [student(1)], call, sleep: nosleep });
    expect(call).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(result.records[0].outcome).toBe('network');
  });

  test('a 400 is never retried — all three known refusals are permanent for that attempt', async () => {
    const call = vi.fn(async () => ({ status: 400, body: { outcome: 'refused', reason: 'lead-time', message: 'too soon' } }));
    await runStudents({ students: [student(1)], call, sleep: nosleep });
    expect(call).toHaveBeenCalledTimes(1);
  });

  test('a 200 is never retried, even when the student was abandoned', async () => {
    const call = vi.fn(async () => ok({
      ...completeBody(), ok: false, outcome: 'abandoned', reason: 'booking-refused', message: 'refused', stranded: true,
    }));
    await runStudents({ students: [student(1)], call, sleep: nosleep });
    expect(call).toHaveBeenCalledTimes(1);
  });
});

describe('runStudents — a 429 pauses the whole run', () => {
  test('a throttle surviving the backoff halts before the next student', async () => {
    const throttle = { status: 429, body: { outcome: 'failed', reason: 'throttled', written: false } };
    const call = vi.fn(async () => throttle);

    const result = await runStudents({
      students: [student(1), student(2), student(3)],
      call,
      sleep: nosleep,
    });

    expect(result.state).toBe('halted');
    expect(result.reason).toBe('throttled');
    // Honest about where the cause may be — the allowance is gym-wide.
    expect(result.message).toContain('another system');
    // Two attempts on student 1, and student 2 never sent.
    expect(call).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(result.remaining).toBe(2);
  });

  test('a throttle that struck after a write still halts, and keeps the row', async () => {
    // The Worker leaves this as a 200 because something WAS written and the
    // body is the only record of it. The page pauses on `reason`, not status.
    const call = vi.fn()
      .mockResolvedValueOnce(ok({
        ...completeBody(), ok: false, outcome: 'abandoned', reason: 'throttled',
        message: 'Clubworx is busy', written: true, stranded: true, strandedDetail: 'contact and pass, no bookings',
      }))
      .mockResolvedValue(ok(completeBody()));

    const result = await runStudents({ students: [student(1), student(2)], call, sleep: nosleep });

    expect(result.state).toBe('halted');
    expect(result.reason).toBe('throttled');
    expect(call).toHaveBeenCalledTimes(1);
    // Completed rows are left intact — the halt states its reason and destroys
    // nothing — and the student it never reached is still in the table.
    expect(result.records).toHaveLength(2);
    expect(result.records[0].stranded).toBe(true);
    expect(result.records[1].state).toBe('not run');
  });
});

describe('runStudents — D7, the circuit breaker', () => {
  test('three consecutive failures halt the run', async () => {
    const fail = ok({ outcome: 'failed', reason: 'unknown', message: 'Sorry! Something new.', written: false });
    const call = vi.fn(async () => fail);

    const result = await runStudents({
      students: [student(1), student(2), student(3), student(4), student(5)],
      call,
      sleep: nosleep,
    });

    expect(result.state).toBe('halted');
    expect(result.reason).toBe('consecutive-failures');
    expect(result.remaining).toBe(2);
    // D11 — the table keeps the whole row set. Three failures, then the two
    // the run never reached, so the halt is visible as a position in the list.
    expect(result.records).toHaveLength(5);
    expect(result.records.filter((r) => r.state === 'not run')).toHaveLength(2);
    expect(result.records[4].detail).toContain('stopped before reaching this student');
  });

  test('a success between failures resets the count', async () => {
    const fail = ok({ outcome: 'failed', reason: 'unknown', message: 'nope', written: false });
    const call = vi.fn()
      .mockResolvedValueOnce(fail)
      .mockResolvedValueOnce(fail)
      .mockResolvedValueOnce(ok(completeBody()))
      .mockResolvedValueOnce(fail)
      .mockResolvedValueOnce(fail);

    const result = await runStudents({
      students: [1, 2, 3, 4, 5].map((k) => student(k)),
      call,
      sleep: nosleep,
    });

    expect(result.state).toBe('complete');
    expect(result.records).toHaveLength(5);
  });

  test('a considered refusal about one student does not feed the breaker', async () => {
    // `needs-confirmation` is #90's open question answered honestly for one
    // student — not a systemic condition. Three of them must not stop a run.
    const needs = ok({
      outcome: 'needs-confirmation', reason: 'pass-not-covering', message: 'the held pass runs out first',
      written: false, contact: { contact_key: 'c9', state: 'matched' }, bookings: [],
    });
    const call = vi.fn(async () => needs);
    const result = await runStudents({ students: [1, 2, 3, 4].map((k) => student(k)), call, sleep: nosleep });
    expect(result.state).toBe('complete');
    expect(result.records).toHaveLength(4);
  });

  test('#51 in miniature — successes, then the back half throttles and it stops', async () => {
    const call = vi.fn(async (payload) => {
      const n = Number(payload.student.last_name);
      if (n <= 4) return ok(completeBody());
      return { status: 429, body: { outcome: 'failed', reason: 'throttled', written: false } };
    });

    const result = await runStudents({ students: [1, 2, 3, 4, 5, 6, 7, 8].map((k) => student(k)), call, sleep: nosleep });

    expect(result.state).toBe('halted');
    expect(result.reason).toBe('throttled');
    // Four succeeded and are kept; the run stopped on the fifth rather than
    // spending the next window failing forty more times.
    expect(result.records.filter((r) => r.state === 'booked')).toHaveLength(4);
    expect(result.remaining).toBe(3);
  });
});

describe('cancelStudents — D12', () => {
  const done = (key) => ({
    key,
    name: `Student ${key}`,
    contactKey: `c${key}`,
    state: 'booked',
    bookings: [booking({ booking_id: `b${key}`, bookingId: `b${key}` })],
    cancel: null,
  });

  const cancelled = (over = {}) => ({
    ok: true, outcome: 'cancelled', reason: null, message: null,
    cancelled: 1, cancelledIds: ['b1'], skipped: 0, failed: [], stillBooked: [], verified: true,
    ...over,
  });

  test('it sends one student per call, with that student’s own rows', async () => {
    const call = vi.fn(async () => ok(cancelled()));
    const records = [done(1), done(2)];
    const result = await cancelStudents({ records, call, sleep: nosleep });

    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[0][0]).toEqual({ contact_key: 'c1', bookings: records[0].bookings });
    expect(result.state).toBe('complete');
    expect(result.records[0].cancel.outcome).toBe('cancelled');
  });

  test('a student with nothing this run booked is never sent', async () => {
    const already = {
      ...done(3),
      state: 'already booked',
      bookings: [booking({ state: 'already booked', booking_id: null, bookingId: null })],
    };
    const call = vi.fn(async () => ok(cancelled()));
    await cancelStudents({ records: [already], call, sleep: nosleep });
    // The interlock, before a request is spent: cancelling a booking this run
    // did not make is #50's worst outcome, and it is not made safe by the
    // Worker also refusing it.
    expect(call).not.toHaveBeenCalled();
  });

  test('a throttle pauses the whole cancel, exactly as it pauses the run', async () => {
    const call = vi.fn(async () => ({ status: 429, body: { outcome: 'failed', reason: 'throttled', cancelled: 0 } }));
    const result = await cancelStudents({ records: [done(1), done(2)], call, sleep: nosleep });
    expect(result.state).toBe('halted');
    expect(result.reason).toBe('throttled');
    expect(call).toHaveBeenCalledTimes(MAX_ATTEMPTS);
  });

  test('an unverified cancel is kept as unverified, not rewritten as done', async () => {
    const call = vi.fn(async () => ok(cancelled({
      ok: false, outcome: 'unverified', verified: false,
      message: 'accepted but could not be confirmed by re-reading',
    })));
    const result = await cancelStudents({ records: [done(1)], call, sleep: nosleep });
    expect(result.records[0].cancel.outcome).toBe('unverified');
    expect(result.records[0].cancel.verified).toBe(false);
  });

  test('a second cancel does not re-send ids the first one removed', async () => {
    const first = { ...done(1), cancel: { outcome: 'partial', cancelledIds: ['b1'] } };
    const two = {
      ...first,
      bookings: [booking({ booking_id: 'b1', bookingId: 'b1' }), booking({ event_id: 'e2', booking_id: 'b9', bookingId: 'b9' })],
    };
    const call = vi.fn(async () => ok(cancelled({ cancelledIds: ['b9'] })));
    await cancelStudents({ records: [two], call, sleep: nosleep });
    expect(call.mock.calls[0][0].bookings.map((b) => b.booking_id)).toEqual(['b9']);
  });

  test('each cancelled student is published as it lands', async () => {
    const seen = [];
    const call = vi.fn(async () => ok(cancelled()));
    await cancelStudents({ records: [done(1), done(2)], call, onRow: (r) => seen.push(r.name), sleep: nosleep });
    expect(seen).toEqual(['Student 1', 'Student 2']);
  });
});

describe('runStore — the record that survives a reload', () => {
  const fakeStorage = () => {
    const map = new Map();
    return {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k),
    };
  };

  test('it round-trips the records', () => {
    const store = runStore(fakeStorage(), 'uj-school-run');
    store.save({ at: '2026-08-21', records: [{ name: 'Ada' }] });
    expect(store.load().records[0].name).toBe('Ada');
  });

  test('an empty store loads as nothing rather than throwing', () => {
    expect(runStore(fakeStorage(), 'k').load()).toBe(null);
  });

  test('corrupt contents load as nothing rather than taking the page down', () => {
    const storage = fakeStorage();
    storage.setItem('k', 'not json');
    expect(runStore(storage, 'k').load()).toBe(null);
  });

  test('a storage that refuses to write does not stop the run', () => {
    const storage = { ...fakeStorage(), setItem: () => { throw new Error('QuotaExceeded'); } };
    // Losing the copy is bad; losing the run because the copy failed is worse,
    // and the records are still in memory and on screen either way.
    expect(() => runStore(storage, 'k').save({ records: [] })).not.toThrow();
  });

  test('a missing storage is tolerated — a private window has none', () => {
    const store = runStore(null, 'k');
    expect(() => store.save({ records: [] })).not.toThrow();
    expect(store.load()).toBe(null);
  });
});

describe('runList — turning the preview into calls', () => {
  const preview = {
    rows: [
      { key: 1, name: 'Ada Lovelace', dob: '2010-12-10', needsHuman: false, clubworx: 'new', contactKey: null, sessions: 2 },
      { key: 2, name: 'Grace Hopper', dob: '2009-12-09', needsHuman: false, clubworx: 'matched', contactKey: 'c2', sessions: 2 },
      { key: 3, name: 'Blocked Row', dob: null, needsHuman: true, clubworx: '', contactKey: null, sessions: 2 },
    ],
    sessions: [
      { event_id: 'e1', event_start_at: '2026-09-01T09:00:00+08:00', spaces_available: 30 },
      { event_id: 'e2', event_start_at: '2026-09-08T09:00:00+08:00', spaces_available: 30 },
    ],
    plan: { membership_plan_id: 'mp-school', membership_duration: '26 weeks' },
  };

  const rows = [
    { key: 1, bucket: 'record', firstName: 'Ada', lastName: 'Lovelace', dob: '2010-12-10' },
    { key: 2, bucket: 'record', firstName: 'Grace', lastName: 'Hopper', dob: '2009-12-09' },
    { key: 3, bucket: 'record', firstName: '', lastName: 'Row', dob: null },
  ];

  test('only rows nothing is waiting on are run, in table order', () => {
    const list = runList({ preview, rows, email: 'noreply+newman@urbanjungleirc.com' });
    expect(list.map((s) => s.key)).toEqual([1, 2]);
  });

  test('the write form of the name is sent, with the school marker as the email', () => {
    const [ada] = runList({ preview, rows, email: 'noreply+newman@urbanjungleirc.com' });
    expect(ada.payload.student).toEqual({
      first_name: 'Ada', last_name: 'Lovelace', dob: '2010-12-10',
      email: 'noreply+newman@urbanjungleirc.com',
    });
    // Null means `new`, and `new` creates a contact Clubworx cannot delete.
    expect(ada.payload.contact_key).toBe(null);
  });

  test('a matched student carries the contact key the operator resolved', () => {
    const [, grace] = runList({ preview, rows, email: 'noreply+newman@urbanjungleirc.com' });
    expect(grace.payload.contact_key).toBe('c2');
  });

  test('the plan and the sessions travel with every student', () => {
    const [ada] = runList({ preview, rows, email: 'noreply+x@urbanjungleirc.com' });
    expect(ada.payload.membership_plan_id).toBe('mp-school');
    expect(ada.payload.membership_duration).toBe('26 weeks');
    // `starts_at` is the name the write chain reads the lead time off.
    expect(ada.payload.events).toEqual([
      { event_id: 'e1', starts_at: '2026-09-01T09:00:00+08:00', spaces_available: 30 },
      { event_id: 'e2', starts_at: '2026-09-08T09:00:00+08:00', spaces_available: 30 },
    ]);
  });

  test('a run with no acknowledgements sends the payload it sends today', () => {
    // ADR 0007's key appears only when a human vouched for something. Absent is
    // the honest encoding of "nobody acknowledged anything", and it keeps a
    // no-override run byte-identical to the one before this feature existed.
    const [ada] = runList({ preview, rows, email: 'noreply+x@urbanjungleirc.com' });
    expect(ada.payload).not.toHaveProperty('lead_time_acknowledged_event_ids');

    const none = runList({ preview, rows, email: 'noreply+x@urbanjungleirc.com', acknowledgedEventIds: [] });
    expect(none[0].payload).not.toHaveProperty('lead_time_acknowledged_event_ids');
  });

  test('the acknowledged event ids travel with every student', () => {
    // Per student, because the gate they narrow is a per-student backstop in
    // the write chain — one call per student is the whole shape of this run.
    const list = runList({
      preview, rows, email: 'noreply+x@urbanjungleirc.com', acknowledgedEventIds: ['e1'],
    });
    expect(list).toHaveLength(2);
    for (const student of list) {
      expect(student.payload.lead_time_acknowledged_event_ids).toEqual(['e1']);
    }
  });

  test('a preview with no resolved plan produces no calls at all', () => {
    const list = runList({ preview: { ...preview, plan: null }, rows, email: 'noreply+x@urbanjungleirc.com' });
    expect(list).toEqual([]);
  });

  test('no school marker produces no calls — the marker is the only provenance there is', () => {
    expect(runList({ preview, rows, email: '' })).toEqual([]);
  });
});
