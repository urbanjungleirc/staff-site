import { describe, it, expect } from 'vitest';
import { ALREADY_BOOKED_STATE, BOOKED } from '../src/bookings.js';
import { unbookRun } from '../src/unbook.js';

/** A stub with the shape `createClubworxClient` hands back. */
const reply = over => ({
  ok: false,
  status: 400,
  url: 'https://app.clubworx.com/api/v2/bookings',
  ms: 1,
  body: null,
  nonJson: false,
  bodyText: null,
  message: null,
  networkError: false,
  ...over,
});

const ok = body => reply({ ok: true, status: 200, body });

/**
 * A client whose DELETE answers are scripted in order, and whose GET answers
 * with the bookings the contact is left holding.
 *
 * The GET matters as much as the DELETEs here: #70's verification rule is that
 * a cancellation is confirmed by re-reading the contact's bookings, never by
 * the `200` the DELETE returned.
 */
const clientWith = ({ deletes = [ok({ success: true })], remaining = [] } = {}) => {
  const calls = [];
  return {
    calls,
    get: async (path, params) => {
      calls.push({ method: 'GET', path, params });
      return Array.isArray(remaining)
        ? ok(remaining.map(id => ({ booking_id: id, event_id: `e-${id}` })))
        : remaining;
    },
    del: async (path, form) => {
      calls.push({ method: 'DELETE', path, form });
      return deletes[Math.min(calls.filter(c => c.method === 'DELETE').length - 1, deletes.length - 1)];
    },
    post: async () => ok({}),
    postForm: async () => ok({}),
  };
};

// The constants, never the literals. `BOOKED` and `ALREADY_BOOKED_STATE` differ
// by one character, and a test that types them by hand is the one place a slip
// would assert the interlock while exercising the wrong state.
const bookedRow = (eventId, bookingId, contactKey = 'ck-1') => ({
  event_id: eventId,
  state: BOOKED,
  booking_id: bookingId,
  contact_key: contactKey,
});

const alreadyBookedRow = (eventId, contactKey = 'ck-1') => ({
  event_id: eventId,
  state: ALREADY_BOOKED_STATE,
  booking_id: null,
  contact_key: contactKey,
});

describe('unbookRun — what it refuses before touching anything', () => {
  it('refuses when no booking rows were supplied at all', async () => {
    const client = clientWith();
    const out = await unbookRun({ client, rows: null });

    expect(out.ok).toBe(false);
    expect(out.reason).toBe('bad-request');
    expect(client.calls).toEqual([]);
  });

  it('treats an empty list as nothing to do rather than as an error', async () => {
    // The page filters to its own booked rows; landing on zero is a legitimate
    // outcome, not a malformed call. Nothing is sent either way.
    const client = clientWith();
    const out = await unbookRun({ client, rows: [] });

    expect(out.ok).toBe(true);
    expect(out.outcome).toBe('nothing-to-cancel');
    expect(out.cancelled).toBe(0);
    expect(client.calls).toEqual([]);
  });

  it('refuses a set mixing two contacts, and cancels nothing', async () => {
    // One call, one contact. Verification is a re-read of ONE contact's
    // bookings, so a mixed set could only be half-verified — and a half-verified
    // cancel reported as done is the shape #70 exists to prevent.
    const client = clientWith();
    const out = await unbookRun({
      client,
      rows: [bookedRow(1, 'b1', 'ck-1'), bookedRow(2, 'b2', 'ck-2')],
    });

    expect(out.ok).toBe(false);
    expect(out.reason).toBe('mixed-contacts');
    expect(client.calls).toEqual([]);
  });

  it('refuses a booked row carrying no contact_key of its own', async () => {
    // The contact travels WITH the booking. A caller-supplied key can be a
    // different student's, which would point a DELETE at somebody else's class.
    const client = clientWith();
    const out = await unbookRun({
      client,
      contactKey: 'ck-1',
      rows: [{ event_id: 1, state: BOOKED, booking_id: 'b1', contact_key: null }],
    });

    expect(out.cancelled).toBe(0);
    expect(out.failed).toHaveLength(1);
    expect(out.failed[0].reason).toMatch(/contact_key of its own/);
    expect(client.calls.filter(c => c.method === 'DELETE')).toEqual([]);
  });
});

describe('unbookRun — the interlock', () => {
  it('never cancels a row marked already booked', async () => {
    // The interlock, not a display distinction: a re-run marks rows `already
    // booked`, and those bookings were not made by this run. One of them may be
    // a session a real member booked themselves.
    const client = clientWith({ remaining: ['b-not-ours'] });
    const out = await unbookRun({
      client,
      rows: [alreadyBookedRow(1), alreadyBookedRow(2)],
    });

    expect(out.outcome).toBe('nothing-to-cancel');
    expect(out.skipped).toBe(2);
    expect(client.calls.filter(c => c.method === 'DELETE')).toEqual([]);
  });

  it('cancels the booked rows and leaves the already-booked ones alone', async () => {
    const client = clientWith({ deletes: [ok({ success: true })], remaining: [] });
    const out = await unbookRun({
      client,
      rows: [bookedRow(1, 'b1'), alreadyBookedRow(2), bookedRow(3, 'b3')],
    });

    expect(out.cancelled).toBe(2);
    expect(out.skipped).toBe(1);
    expect(client.calls.filter(c => c.method === 'DELETE').map(c => c.path)).toEqual([
      'bookings/b1',
      'bookings/b3',
    ]);
  });

  it('takes the contact_key it sends from the booking row', async () => {
    // Omitting it answers 401 "Authorization failed", which reads like a key
    // without delete permission and was misdiagnosed as exactly that for a week
    // in #50. Taking it from the row is what makes it impossible to forget.
    const client = clientWith();
    await unbookRun({ client, rows: [bookedRow(1, 'b1', 'ck-9')] });

    const del = client.calls.find(c => c.method === 'DELETE');
    expect(del.form).toEqual({ contact_key: 'ck-9' });
  });

  it('refuses a row belonging to a contact other than the one being rolled back', async () => {
    const client = clientWith();
    const out = await unbookRun({
      client,
      contactKey: 'ck-1',
      rows: [bookedRow(1, 'b1', 'ck-2')],
    });

    expect(out.ok).toBe(false);
    expect(out.reason).toBe('mixed-contacts');
    expect(client.calls.filter(c => c.method === 'DELETE')).toEqual([]);
  });
});

describe('unbookRun — verification is a re-read, never the 200', () => {
  it('re-reads the contact bookings after cancelling', async () => {
    const client = clientWith({ remaining: [] });
    const out = await unbookRun({ client, rows: [bookedRow(1, 'b1')] });

    const read = client.calls.find(c => c.method === 'GET');
    expect(read.path).toBe('bookings');
    expect(read.params).toMatchObject({ contact_key: 'ck-1' });
    expect(out.verified).toBe(true);
    expect(out.outcome).toBe('cancelled');
    expect(out.ok).toBe(true);
  });

  it('reports a booking still present on the re-read, despite the 200', async () => {
    // A DELETE that answers 200 and changes nothing is the one failure a status
    // code cannot show. It is reported as still booked, not as cancelled.
    const client = clientWith({ deletes: [ok({ success: true })], remaining: ['b1'] });
    const out = await unbookRun({ client, rows: [bookedRow(1, 'b1')] });

    expect(out.ok).toBe(false);
    expect(out.outcome).toBe('still-booked');
    expect(out.stillBooked).toEqual(['b1']);
    expect(out.verified).toBe(false);
    expect(out.message).toMatch(/still/i);
  });

  it('does not claim success when the verifying read itself fails', async () => {
    const client = clientWith({
      remaining: reply({ ok: false, status: 500, message: 'upstream is unwell' }),
    });
    const out = await unbookRun({ client, rows: [bookedRow(1, 'b1')] });

    expect(out.ok).toBe(false);
    expect(out.outcome).toBe('unverified');
    expect(out.reason).toBe('bookings-unread');
    expect(out.cancelled).toBe(1);
    expect(out.verified).toBe(false);
  });

  it('does not re-read when there was nothing to cancel', async () => {
    // The read costs a request against a gym-wide allowance and can conclude
    // nothing: no cancel was attempted, so there is no claim to verify.
    const client = clientWith();
    const out = await unbookRun({ client, rows: [alreadyBookedRow(1)] });

    expect(client.calls).toEqual([]);
    expect(out.verified).toBe(false);
  });
});

describe('unbookRun — partial and failed cancels', () => {
  it('keeps going after one cancel fails, and reports the leftover', async () => {
    // A student half-rolled-back is worse than one fully rolled back, and the
    // failures have to be nameable so a human can finish them.
    const client = clientWith({
      deletes: [reply({ ok: false, status: 500, message: 'nope' }), ok({ success: true })],
      remaining: ['b1'],
    });
    const out = await unbookRun({ client, rows: [bookedRow(1, 'b1'), bookedRow(2, 'b2')] });

    expect(out.cancelled).toBe(1);
    expect(out.failed).toHaveLength(1);
    expect(out.failed[0].booking_id).toBe('b1');
    expect(out.outcome).toBe('partial');
    expect(out.ok).toBe(false);
  });

  it('names a booked row that has no booking id as one to undo by hand', async () => {
    const client = clientWith();
    const out = await unbookRun({
      client,
      rows: [{ event_id: 7, state: BOOKED, booking_id: null, contact_key: 'ck-1' }],
    });

    expect(out.cancelled).toBe(0);
    expect(out.failed[0].reason).toMatch(/by hand/);
    expect(out.ok).toBe(false);
  });

  it('stops on a throttle rather than spending the rest of a gym-wide allowance', async () => {
    // §11 — the allowance is shared with the roster Worker and n8n, so firing
    // the remaining rows into a window that is already refusing both wastes it
    // and reports cancellable bookings as needing a human.
    const client = clientWith({ deletes: [reply({ ok: false, status: 429 })] });
    const out = await unbookRun({
      client,
      rows: [bookedRow(1, 'b1'), bookedRow(2, 'b2'), bookedRow(3, 'b3')],
    });

    expect(client.calls.filter(c => c.method === 'DELETE')).toHaveLength(1);
    expect(out.failed.filter(f => f.attempted === false)).toHaveLength(2);
    expect(out.reason).toBe('throttled');
  });

  it('will not report a cancel confirmed off a re-read it could not finish', async () => {
    // A full page is an unfinished list, and absence from an unfinished list
    // proves nothing. "Cancelled" and "probably cancelled" send an operator to
    // different places.
    const full = Array.from({ length: 200 }, (_, i) => ({ booking_id: `x${i}`, event_id: i }));
    const client = clientWith({ remaining: full });
    const out = await unbookRun({ client, rows: [bookedRow(1, 'b1')] });

    expect(out.cancelled).toBe(1);
    expect(out.verified).toBe(false);
    expect(out.outcome).toBe('unverified');
    expect(out.reason).toBe('bookings-truncated');
  });

  it('reports a throttle as throttled, so the page pauses the whole run', async () => {
    // §11 — the allowance is gym-wide, so a 429 pauses the run rather than one
    // row. Backing off a single row while the others continue just spends the
    // next window failing.
    const client = clientWith({ deletes: [reply({ ok: false, status: 429 })] });
    const out = await unbookRun({ client, rows: [bookedRow(1, 'b1')] });

    expect(out.reason).toBe('throttled');
    expect(out.cancelled).toBe(0);
    expect(out.ok).toBe(false);
  });

  it('counts every request it spent', async () => {
    const client = clientWith({ remaining: [] });
    const out = await unbookRun({ client, rows: [bookedRow(1, 'b1'), bookedRow(2, 'b2')] });

    // Two deletes and the verifying read.
    expect(out.requests).toBe(3);
  });
});
