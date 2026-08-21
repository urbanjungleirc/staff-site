import { describe, it, expect } from 'vitest';
import {
  ALREADY_BOOKED,
  CLASS_CLOSED,
  NO_FREE_SPACES,
  classifyRefusal,
  describeRefusal,
  bookingIdOf,
  bookEvent,
  cancelBooking,
  cancelRunBookings,
  readBookings,
} from '../src/bookings.js';

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
const refused = message => reply({ status: 400, body: { error: message }, message });

const clientReturning = (...responses) => {
  const calls = [];
  const next = () => responses[Math.min(calls.length - 1, responses.length - 1)];
  return {
    calls,
    get: async (path, params) => {
      calls.push({ method: 'GET', path, params });
      return next();
    },
    post: async (path, payload) => {
      calls.push({ method: 'POST', path, payload });
      return next();
    },
    del: async (path, form) => {
      calls.push({ method: 'DELETE', path, form });
      return next();
    },
  };
};

describe('classifyRefusal — the message string is the only discriminator', () => {
  it('recognises the three measured 400s', () => {
    expect(classifyRefusal(ALREADY_BOOKED)).toBe('already-booked');
    expect(classifyRefusal(CLASS_CLOSED)).toBe('closed');
    expect(classifyRefusal(NO_FREE_SPACES)).toBe('no-spaces');
  });

  it('survives a curly apostrophe, which is one HTML entity away from arriving', () => {
    expect(classifyRefusal('Woops! You’ve already booked into this class!')).toBe(
      'already-booked',
    );
  });

  it('survives case and whitespace drift without widening to a different message', () => {
    expect(classifyRefusal('  sorry, this class has NO FREE SPACES available.  ')).toBe('no-spaces');
  });

  it('calls anything it does not recognise unknown, rather than the nearest match', () => {
    // D6: paraphrasing an unrecognised message is what makes new Clubworx
    // behaviour invisible. #50 is the cautionary tale.
    expect(classifyRefusal('Sorry, this class is full.')).toBe('unknown');
    expect(classifyRefusal('Contact has no active membership.')).toBe('unknown');
    expect(classifyRefusal('')).toBe('unknown');
    expect(classifyRefusal(null)).toBe('unknown');
  });
});

describe('describeRefusal', () => {
  it('never says "class full" for the spaces refusal — it is not a capacity message', () => {
    const shown = describeRefusal('no-spaces', { message: NO_FREE_SPACES, spacesAvailable: 25 });
    expect(shown.toLowerCase()).not.toContain('full');
    expect(shown).toContain('check the session');
  });

  it('puts spaces_available beside the spaces refusal, since it has been misleading', () => {
    expect(describeRefusal('no-spaces', { message: NO_FREE_SPACES, spacesAvailable: 25 })).toContain(
      '25',
    );
  });

  it('repeats an unknown message verbatim and attributes it to Clubworx', () => {
    const raw = 'Something nobody here has seen before.';
    const shown = describeRefusal('unknown', { message: raw });
    expect(shown).toContain(raw);
    expect(shown).toContain('Clubworx');
  });

  it('does not invent a message when Clubworx sent none', () => {
    expect(describeRefusal('unknown', { message: null })).toContain('no message');
  });
});

describe('bookingIdOf', () => {
  it('finds the id wherever this API chose to put it', () => {
    expect(bookingIdOf({ booking_id: 63510241 })).toBe('63510241');
    expect(bookingIdOf({ id: 7 })).toBe('7');
    expect(bookingIdOf({ booking: { booking_id: 8 } })).toBe('8');
    expect(bookingIdOf([{ id: 9 }])).toBe('9');
  });

  it('answers null rather than a guess when there is no id', () => {
    expect(bookingIdOf({ success: true })).toBeNull();
    expect(bookingIdOf(null)).toBeNull();
  });
});

describe('bookEvent', () => {
  it('sends JSON to /bookings — the measured shape, not the form the spec text claims', async () => {
    const client = clientReturning(ok({ booking_id: 63510241 }));
    await bookEvent({ client, contactKey: 'ck-1', eventId: 42 });

    expect(client.calls[0]).toMatchObject({
      method: 'POST',
      path: 'bookings',
      payload: { contact_key: 'ck-1', event_id: 42 },
    });
  });

  it('reads a 200 as booked and keeps the id, because cancelling needs it', async () => {
    const client = clientReturning(ok({ booking_id: 63510241 }));
    expect(await bookEvent({ client, contactKey: 'ck-1', eventId: 42 })).toMatchObject({
      state: 'booked',
      booking_id: '63510241',
      // The row carries the contact it belongs to, so a later cancel takes the
      // key from the booking rather than from whoever is asking.
      contact_key: 'ck-1',
    });
  });

  it('treats "already booked" as a success, never as an error', async () => {
    // It IS the idempotency guarantee — the thing that makes D5's re-run safe.
    const client = clientReturning(refused(ALREADY_BOOKED));
    expect(await bookEvent({ client, contactKey: 'ck-1', eventId: 42 })).toMatchObject({
      state: 'already booked',
      refusal: 'already-booked',
      booking_id: null,
    });
  });

  it('carries no booking id on an already-booked row, which is the cancel interlock', async () => {
    const client = clientReturning(refused(ALREADY_BOOKED));
    const row = await bookEvent({ client, contactKey: 'ck-1', eventId: 42 });
    expect(row.booking_id).toBeNull();
  });

  it('reports the closed-for-bookings refusal as permanent for that event', async () => {
    const client = clientReturning(refused(CLASS_CLOSED));
    expect(await bookEvent({ client, contactKey: 'ck-1', eventId: 42 })).toMatchObject({
      state: 'refused',
      refusal: 'closed',
      retryable: false,
    });
  });

  it('never retries a 400, including one it does not recognise', async () => {
    const client = clientReturning(refused('A brand new complaint.'));
    expect(await bookEvent({ client, contactKey: 'ck-1', eventId: 42 })).toMatchObject({
      state: 'refused',
      refusal: 'unknown',
      retryable: false,
      message: 'A brand new complaint.',
    });
  });

  it('marks a 429 as throttled, and as the one thing that pauses the whole run', async () => {
    const client = clientReturning(reply({ status: 429, bodyText: '<html>too many</html>' }));
    expect(await bookEvent({ client, contactKey: 'ck-1', eventId: 42 })).toMatchObject({
      state: 'failed',
      reason: 'throttled',
      retryable: true,
    });
  });

  it('marks a 5xx and a network error as retryable failures', async () => {
    const server = clientReturning(reply({ status: 503 }));
    expect(await bookEvent({ client: server, contactKey: 'ck-1', eventId: 42 })).toMatchObject({
      state: 'failed',
      retryable: true,
    });

    const dead = clientReturning(reply({ status: 0, networkError: true, message: 'ECONNRESET' }));
    expect(await bookEvent({ client: dead, contactKey: 'ck-1', eventId: 42 })).toMatchObject({
      state: 'failed',
      retryable: true,
    });
  });

  it('refuses a 200 whose body is not a booking, rather than reporting a booking', async () => {
    // A 200 with no id anywhere is a shape nobody here has seen. Calling it
    // booked would put a row in the result table that cannot be cancelled.
    const client = clientReturning(ok({ success: true }));
    expect(await bookEvent({ client, contactKey: 'ck-1', eventId: 42 })).toMatchObject({
      state: 'booked',
      booking_id: null,
      unverifiable: true,
    });
  });
});

describe('cancelBooking', () => {
  it('form-encodes contact_key, the parameter that made #50 wrong', async () => {
    const client = clientReturning(ok({ success: true }));
    await cancelBooking({ client, bookingId: '63510241', contactKey: 'ck-1' });

    expect(client.calls[0]).toMatchObject({
      method: 'DELETE',
      path: 'bookings/63510241',
      form: { contact_key: 'ck-1' },
    });
  });

  it('refuses to send a cancel with no contact key rather than discovering the 401 again', async () => {
    const client = clientReturning(ok({ success: true }));
    const res = await cancelBooking({ client, bookingId: '1', contactKey: null });

    expect(res.ok).toBe(false);
    expect(client.calls).toHaveLength(0);
  });
});

describe('cancelRunBookings — the safety interlock', () => {
  const bookedRow = (eventId, bookingId, contactKey = 'ck-1') => ({
    event_id: eventId,
    state: 'booked',
    booking_id: bookingId,
    contact_key: contactKey,
  });

  it('cancels the rows this run booked', async () => {
    const client = clientReturning(ok({ success: true }));
    const out = await cancelRunBookings({
      client,
      contactKey: 'ck-1',
      rows: [bookedRow(1, 'b1'), bookedRow(2, 'b2')],
    });

    expect(out.cancelled).toBe(2);
    expect(client.calls.filter(c => c.method === 'DELETE').map(c => c.path)).toEqual([
      'bookings/b1',
      'bookings/b2',
    ]);
  });

  it('confirms the cancellation by re-reading, never by the DELETE 200', async () => {
    // #60 established the reversal by re-count — 1 before, 0 after — because a
    // status code cannot show a DELETE that was accepted and changed nothing.
    const client = clientReturning(ok({ success: true }), ok([]));
    const out = await cancelRunBookings({ client, contactKey: 'ck-1', rows: [bookedRow(1, 'b1')] });

    const read = client.calls.find(c => c.method === 'GET');
    expect(read.path).toBe('bookings');
    expect(read.params).toMatchObject({ contact_key: 'ck-1' });
    expect(out.verified).toBe(true);
    expect(out.stillBooked).toEqual([]);
  });

  it('catches a booking still held by its EVENT, when the list carries no id it knows', async () => {
    // The load-bearing half. `bookingIdOf` tolerates several shapes because the
    // create response was never documented; if a list row carries none of them,
    // an id-only check passes having proved nothing.
    const client = clientReturning(ok({ success: true }), ok([{ some_other_id: 'x', event_id: 1 }]));
    const out = await cancelRunBookings({ client, contactKey: 'ck-1', rows: [bookedRow(1, 'b1')] });

    expect(out.verified).toBe(false);
    expect(out.stillBooked).toEqual(['b1']);
  });

  it('will not call a cancel verified off a list it did not finish reading', async () => {
    // A full page is an unfinished list, never an answer — and absence from an
    // unfinished list proves nothing.
    const full = Array.from({ length: 200 }, (_, i) => ({ booking_id: `x${i}`, event_id: i }));
    const client = clientReturning(ok({ success: true }), ok(full));
    const out = await cancelRunBookings({ client, contactKey: 'ck-1', rows: [bookedRow(1, 'b1')] });

    expect(out.cancelled).toBe(1);
    expect(out.verified).toBe(false);
    expect(out.verifyReason).toBe('bookings-truncated');
  });

  it('does not spend a request verifying when nothing was cancelled', async () => {
    const client = clientReturning(ok({ success: true }));
    const out = await cancelRunBookings({
      client,
      contactKey: 'ck-1',
      rows: [{ event_id: 1, state: 'already booked', booking_id: 'b1', contact_key: 'ck-1' }],
    });

    expect(client.calls).toHaveLength(0);
    expect(out.verifyReason).toBe('nothing-cancelled');
  });

  it('stops on a throttle instead of spending the rest of a gym-wide allowance', async () => {
    // §11 — a 429 pauses the whole run, not one row. The rows after it are
    // reported un-attempted, because they are still cancellable.
    const client = clientReturning(reply({ ok: false, status: 429 }));
    const out = await cancelRunBookings({
      client,
      contactKey: 'ck-1',
      rows: [bookedRow(1, 'b1'), bookedRow(2, 'b2'), bookedRow(3, 'b3')],
    });

    expect(client.calls.filter(c => c.method === 'DELETE')).toHaveLength(1);
    expect(out.throttled).toBe(true);
    expect(out.failed).toHaveLength(3);
    expect(out.failed.filter(f => f.attempted === false)).toHaveLength(2);
  });

  it('NEVER cancels a row marked already booked', async () => {
    // The worst outcome available on this map: deleting a booking this run did
    // not create, possibly a session a real member booked themselves (#50).
    const client = clientReturning(ok({ success: true }));
    const out = await cancelRunBookings({
      client,
      contactKey: 'ck-1',
      rows: [
        { event_id: 1, state: 'already booked', booking_id: 'b-somebody-elses', contact_key: 'ck-1' },
        bookedRow(2, 'b2'),
      ],
    });

    expect(client.calls.filter(c => c.method === 'DELETE').map(c => c.path)).toEqual(['bookings/b2']);
    expect(out.skipped).toBe(1);
  });

  it('holds the interlock even when the caller hands it an id on the already-booked row', async () => {
    const client = clientReturning(ok({ success: true }));
    const out = await cancelRunBookings({
      client,
      contactKey: 'ck-1',
      rows: [{ event_id: 1, state: 'already booked', booking_id: 'b1', contact_key: 'ck-1' }],
    });

    expect(client.calls).toHaveLength(0);
    expect(out.cancelled).toBe(0);
  });

  it('skips a booked row that has no id, and says so rather than silently dropping it', async () => {
    const client = clientReturning(ok({ success: true }));
    const out = await cancelRunBookings({
      client,
      contactKey: 'ck-1',
      rows: [{ event_id: 1, state: 'booked', booking_id: null, contact_key: 'ck-1' }],
    });

    expect(client.calls).toHaveLength(0);
    expect(out.failed).toHaveLength(1);
    expect(out.failed[0].reason).toContain('no booking id');
  });

  it('sends the contact key off the booking row, not the one the caller passed', async () => {
    const client = clientReturning(ok({ success: true }));
    await cancelRunBookings({ client, contactKey: undefined, rows: [bookedRow(1, 'b1', 'ck-row')] });

    expect(client.calls[0].form).toMatchObject({ contact_key: 'ck-row' });
  });

  it('refuses a row belonging to a different contact than the one being rolled back', async () => {
    // A DELETE aimed at somebody else's class is the worst outcome on this map.
    const client = clientReturning(ok({ success: true }));
    const out = await cancelRunBookings({
      client,
      contactKey: 'ck-1',
      rows: [bookedRow(1, 'b1', 'ck-someone-else')],
    });

    expect(client.calls).toHaveLength(0);
    expect(out.failed[0].reason).toContain('different contact');
  });

  it('refuses a booked row carrying no contact key of its own', async () => {
    const client = clientReturning(ok({ success: true }));
    const out = await cancelRunBookings({
      client,
      contactKey: 'ck-1',
      rows: [{ event_id: 1, state: 'booked', booking_id: 'b1', contact_key: null }],
    });

    expect(client.calls).toHaveLength(0);
    expect(out.failed).toHaveLength(1);
  });

  it('keeps going when one cancel fails, and reports which one', async () => {
    let n = 0;
    const client = {
      calls: [],
      del: async path => {
        client.calls.push({ path });
        n += 1;
        return n === 1 ? reply({ status: 500 }) : ok({ success: true });
      },
      // The verifying re-read is part of the contract now: a cancel is confirmed
      // by re-reading the contact's bookings, never by the DELETE's 200.
      get: async () => ok([]),
    };

    const out = await cancelRunBookings({
      client,
      contactKey: 'ck-1',
      rows: [bookedRow(1, 'b1'), bookedRow(2, 'b2')],
    });

    expect(out.cancelled).toBe(1);
    expect(out.failed).toHaveLength(1);
    expect(out.failed[0].booking_id).toBe('b1');
  });
});

describe('readBookings', () => {
  it('reads a contact own bookings, which is how a write is verified', async () => {
    const client = clientReturning(ok([{ booking_id: 1, event_id: 42 }]));
    const out = await readBookings({ client, contactKey: 'ck-1' });

    expect(client.calls[0]).toMatchObject({ path: 'bookings', params: { contact_key: 'ck-1' } });
    expect(out).toMatchObject({ ok: true, eventIds: ['42'] });
  });

  it('refuses a body that is not a list rather than reading it as no bookings', async () => {
    const client = clientReturning(ok({ error: 'nope' }));
    expect((await readBookings({ client, contactKey: 'ck-1' })).ok).toBe(false);
  });
});
