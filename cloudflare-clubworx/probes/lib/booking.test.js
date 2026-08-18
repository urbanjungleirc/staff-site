import { describe, it, expect } from 'vitest';
import { createBooker, assertProbeBooking, bookingIdOf } from './booking.mjs';

// The booking path is the first place on this map that can issue DELETE against
// a production database full of real customers' bookings. A mistaken create is
// reversible here — that is the one thing bookings have over contacts — but a
// mistaken *cancellation* takes a real member off a class they turn up to.
//
// So the assertions below are weighted accordingly: most of them are about what
// this module refuses to do.

const key = 'unique-not-a-real-key';
const OURS = 'ck-probe-a';
const STRANGER = 'ck-somebody-real';
const EVENT = 4242;

const fakeFetch = (calls, response = {}) => async (url, init) => {
  calls.push({ url, init });
  return {
    status: response.status ?? 200,
    headers: new Headers(response.headers ?? { 'content-type': 'application/json' }),
    text: async () => response.text ?? '{"booking_id":"bk-1"}',
  };
};

const booker = (calls, opts = {}) =>
  createBooker({
    accountKey: key,
    allowedContactKeys: [OURS],
    fetchImpl: fakeFetch(calls, opts.response),
    ...opts,
  });

describe('assertProbeBooking', () => {
  it('refuses a contact_key that did not come from the identity-filtered search', () => {
    // The control that matters. A key reaching here that was not recognised as
    // a probe contact belongs to one of ~60,000 real people.
    expect(() => assertProbeBooking({ contact_key: STRANGER, event_id: EVENT }, [OURS])).toThrow(
      /not a recognised probe contact/,
    );
  });

  it('refuses when no probe contacts were recognised at all', () => {
    // An empty allowlist means the search found nothing. Booking anything at
    // that point is booking a guess.
    expect(() => assertProbeBooking({ contact_key: OURS, event_id: EVENT }, [])).toThrow(
      /no probe contacts were recognised/,
    );
  });

  it('refuses a booking with no contact_key or no event_id', () => {
    expect(() => assertProbeBooking({ event_id: EVENT }, [OURS])).toThrow(/without a contact_key/);
    expect(() => assertProbeBooking({ contact_key: OURS }, [OURS])).toThrow(/without an event_id/);
  });

  it('accepts a recognised probe contact', () => {
    expect(() => assertProbeBooking({ contact_key: OURS, event_id: EVENT }, [OURS])).not.toThrow();
  });

  it('accepts event_id 0 rather than treating it as absent', () => {
    // A falsy-but-present id is a real id. Rejecting it would be a bug that
    // only shows up against whichever gym numbers its events from zero.
    expect(() => assertProbeBooking({ contact_key: OURS, event_id: 0 }, [OURS])).not.toThrow();
  });
});

describe('createBooker.book', () => {
  it('does not touch the network unless writing is explicitly enabled', async () => {
    const calls = [];
    const { book } = booker(calls);

    const res = await book({ contact_key: OURS, event_id: EVENT });

    expect(calls).toHaveLength(0);
    expect(res.dryRun).toBe(true);
  });

  it('reports what a dry run would have sent, so --dry-run is reviewable', async () => {
    const { book } = booker([]);
    const res = await book({ contact_key: OURS, event_id: EVENT, label: 'Q1', why: 'baseline' });

    expect(res.wouldSend).toEqual({ contact_key: OURS, event_id: EVENT });
    expect(res.status).toBeNull();
  });

  it('runs the guard on a dry run too, so the refusal is proven without writing', async () => {
    const calls = [];
    const { book } = booker(calls);

    const res = await book({ contact_key: STRANGER, event_id: EVENT });

    expect(res.refused).toMatch(/not a recognised probe contact/);
    expect(calls).toHaveLength(0);
  });

  it('refuses a stranger even when live, without issuing a request', async () => {
    const calls = [];
    const { book } = booker(calls, { live: true });

    const res = await book({ contact_key: STRANGER, event_id: EVENT });

    expect(res.refused).toMatch(/not a recognised probe contact/);
    expect(calls).toHaveLength(0);
    expect(book.writes).toBe(0);
  });

  it('POSTs the booking as JSON when live, dropping bookkeeping fields', async () => {
    const calls = [];
    const { book } = booker(calls, { live: true });

    await book({ contact_key: OURS, event_id: EVENT, label: 'Q1', why: 'baseline' });

    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(calls[0].init.body)).toEqual({ contact_key: OURS, event_id: EVENT });
  });

  it('never lets the account key reach the recorded url', async () => {
    const { book } = booker([], { live: true });
    const res = await book({ contact_key: OURS, event_id: EVENT });

    expect(res.url).not.toContain(key);
    expect(res.url).toContain('<CLUBWORX_ACCOUNT_KEY>');
  });

  it('keeps a non-JSON body as redacted text rather than dropping it', async () => {
    // A rejection for "no membership" is the answer to question 2 and may well
    // arrive as HTML from a WAF or a validation layer.
    const { book } = booker([], {
      live: true,
      response: { status: 422, text: `<html>no plan for ${key}</html>`, headers: { 'content-type': 'text/html' } },
    });

    const res = await book({ contact_key: OURS, event_id: EVENT });

    expect(res.status).toBe(422);
    expect(res.bodyText).toContain('no plan');
    expect(res.bodyText).not.toContain(key);
  });

  it('redacts the key out of a connection error', async () => {
    const { book } = createBooker({
      accountKey: key,
      allowedContactKeys: [OURS],
      live: true,
      fetchImpl: async () => {
        throw new Error(`connect ECONNREFUSED for account_key=${key}`);
      },
    });

    const res = await book({ contact_key: OURS, event_id: EVENT });

    expect(res.error).not.toContain(key);
    expect(res.error).toContain('<CLUBWORX_ACCOUNT_KEY>');
  });
});

describe('createBooker.cancel', () => {
  it('refuses any booking id it did not create', async () => {
    // The single most important assertion in this file. An arbitrary id is a
    // real customer's booking.
    const calls = [];
    const { cancel } = booker(calls, { live: true });

    const res = await cancel('bk-somebody-elses');

    expect(res.refused).toMatch(/did not create it/);
    expect(calls).toHaveLength(0);
    expect(cancel.writes).toBe(0);
  });

  it('cancels a booking it created itself', async () => {
    const calls = [];
    const { book, cancel } = booker(calls, { live: true });

    const created = await book({ contact_key: OURS, event_id: EVENT });
    const res = await cancel(created.bookingId);

    expect(res.refused).toBeNull();
    expect(calls[1].init.method).toBe('DELETE');
    expect(calls[1].url).toContain('bookings/bk-1');
  });

  it('sends no body on DELETE', async () => {
    const calls = [];
    const { book, cancel } = booker(calls, { live: true });

    const created = await book({ contact_key: OURS, event_id: EVENT });
    await cancel(created.bookingId);

    expect(calls[1].init.body).toBeUndefined();
  });

  it('does not touch the network on a dry run, even for a booking it created', async () => {
    const calls = [];
    const { book, cancel, allowCancel } = booker(calls);

    await book({ contact_key: OURS, event_id: EVENT });
    allowCancel('bk-1', OURS);
    const res = await cancel('bk-1');

    expect(calls).toHaveLength(0);
    expect(res.dryRun).toBe(true);
    expect(res.wouldCancel).toBe('bk-1');
  });

  it('does not record a cancellable id when the create failed', async () => {
    // A booking that never came into existence must not leave an id behind that
    // a later DELETE could point at.
    const { book, cancel } = booker([], {
      live: true,
      response: { status: 422, text: '{}' },
    });

    await book({ contact_key: OURS, event_id: EVENT });
    const res = await cancel('bk-1');

    expect(res.refused).toMatch(/did not create it/);
  });
});

describe('createBooker.allowCancel', () => {
  it('vouches for a booking found on a probe contact, so an earlier run can be cleaned up', async () => {
    const calls = [];
    const { cancel, allowCancel } = booker(calls, { live: true });

    allowCancel('bk-from-yesterday', OURS);
    const res = await cancel('bk-from-yesterday');

    expect(res.refused).toBeNull();
    expect(calls[0].init.method).toBe('DELETE');
  });

  it('refuses to vouch for a booking on a contact that is not ours', () => {
    // Without the contact key, an id alone would let any booking through — which
    // would defeat the whole point of the cancellable set.
    const { allowCancel } = booker([], { live: true });

    expect(() => allowCancel('bk-1', STRANGER)).toThrow(/not a recognised probe contact/);
  });
});

describe('bookingIdOf', () => {
  it('finds the id wherever this API chose to put it', () => {
    expect(bookingIdOf({ booking_id: 'a' })).toBe('a');
    expect(bookingIdOf({ id: 'b' })).toBe('b');
    expect(bookingIdOf({ booking: { booking_id: 'c' } })).toBe('c');
    expect(bookingIdOf([{ booking_id: 'd' }])).toBe('d');
  });

  it('returns null rather than guessing when there is nothing to find', () => {
    expect(bookingIdOf(null)).toBeNull();
    expect(bookingIdOf({})).toBeNull();
    expect(bookingIdOf('nope')).toBeNull();
  });
});
