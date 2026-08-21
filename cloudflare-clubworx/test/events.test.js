import { describe, it, expect } from 'vitest';
import {
  MAX_PAGES,
  PAGE_SIZE,
  describeLeadTime,
  listEvents,
  pickBookableEvents,
  resolveEvent,
} from '../src/events.js';

// The event picker's read, and the three ways it can quietly mislead.
//
// **The date window is required.** Omitting both date parameters is HTTP 422,
// not "everything" (#51). So a window is validated here rather than discovered
// as an upstream refusal.
//
// **A full page is silent truncation.** No total, no next-page link, no header —
// a truncated page is indistinguishable from a complete list by anything in the
// response, and a staff member opening "events this term" and seeing 50 rows has
// no way to know the session they want is on page 2. So this pages to
// exhaustion, and says so out loud when it cannot.
//
// **Dropping an event is worse than showing a bad one.** The route annotates and
// never filters: a session missing from the picker is invisible, and a session
// shown with `spaces_available: 0` beside it is a decision a human can make.
// `pickBookableEvents` is the probes' own selector, which does filter, because a
// probe needs one safe event rather than a complete list.

const NOW = '2026-08-21T02:00:00.000Z';

const event = (over = {}) => ({
  event_id: 101,
  event_name: 'School Session',
  event_start_at: '2026-08-28T01:00:00.000Z',
  event_end_at: '2026-08-28T02:30:00.000Z',
  location_id: 'loc-1',
  location_name: 'Main Gym',
  free_class: false,
  event_full: false,
  spaces_available: 20,
  instructor_name: 'A Staff Member',
  event_description: 'notes',
  ...over,
});

const filler = n => Array.from({ length: n }, (_, i) => event({ event_id: 1000 + i }));

/** A Clubworx client stub: one canned page per page number, plus a call recorder. */
function clientWith(pages, over = {}) {
  const calls = [];
  return {
    calls,
    get: async (path, params = {}) => {
      calls.push({ path, params });
      const answer = pages[path === 'events' ? params.page : path];
      const body = answer === undefined ? [] : answer;
      return {
        ok: true,
        status: 200,
        url: `https://app.clubworx.com/api/v2/${path}`,
        ms: 1,
        body,
        nonJson: false,
        bodyText: null,
        message: null,
        networkError: false,
        ...over,
      };
    },
  };
}

const list = (client, over = {}) =>
  listEvents({ client, from: '2026-08-21', to: '2026-09-30', now: NOW, ...over });

describe('describeLeadTime', () => {
  it('reports hours ahead and leaves a comfortable event alone', () => {
    const lead = describeLeadTime('2026-08-28T01:00:00.000Z', { now: NOW });
    expect(lead.past).toBe(false);
    expect(lead.withinLeadTime).toBe(false);
    expect(lead.hoursAhead).toBeGreaterThan(24);
  });

  it('flags an event inside the 24-hour rule', () => {
    const lead = describeLeadTime('2026-08-21T12:00:00.000Z', { now: NOW });
    expect(lead.withinLeadTime).toBe(true);
    expect(lead.past).toBe(false);
  });

  it('tells past apart from too-soon', () => {
    const lead = describeLeadTime('2026-08-20T12:00:00.000Z', { now: NOW });
    expect(lead.past).toBe(true);
    expect(lead.withinLeadTime).toBe(false);
  });

  it('reports an unreadable timestamp rather than guessing at it', () => {
    const lead = describeLeadTime('sometime tuesday', { now: NOW });
    expect(lead.unreadable).toBe(true);
    expect(lead.withinLeadTime).toBe(null);
  });

  it('respects an offset rather than assuming UTC', () => {
    // Clubworx returns Perth-local timestamps with a +08:00 offset. Reading one
    // as UTC is an eight-hour error, which is the difference between a session
    // inside the lead time and one comfortably outside it.
    const lead = describeLeadTime('2026-08-21T18:00:00.000+08:00', { now: '2026-08-21T07:00:00Z' });
    expect(lead.hoursAhead).toBe(3);
    expect(lead.withinLeadTime).toBe(true);
  });
});

describe('pickBookableEvents', () => {
  it('splits free from paid and drops what a probe must not book', () => {
    const picked = pickBookableEvents(
      [
        event({ event_id: 1, free_class: true }),
        event({ event_id: 2 }),
        event({ event_id: 3, event_start_at: '2026-08-01T01:00:00.000Z' }),
        event({ event_id: 4, spaces_available: 0 }),
        event({ event_id: 5, event_full: true }),
      ],
      { now: NOW },
    );

    expect(picked.free.map(e => e.event_id)).toEqual([1]);
    expect(picked.paid.map(e => e.event_id)).toEqual([2]);
    expect(picked.skipped).toBe(3);
  });

  it('orders by start time, so the soonest usable event is first', () => {
    const picked = pickBookableEvents(
      [
        event({ event_id: 1, event_start_at: '2026-09-01T01:00:00.000Z' }),
        event({ event_id: 2, event_start_at: '2026-08-28T01:00:00.000Z' }),
      ],
      { now: NOW },
    );
    expect(picked.paid.map(e => e.event_id)).toEqual([2, 1]);
  });

  it('survives a non-array body', () => {
    expect(pickBookableEvents(null)).toEqual({ free: [], paid: [], skipped: 0 });
  });
});

describe('listEvents', () => {
  it('sends the measured window parameters and a page size past the default', async () => {
    const client = clientWith({ 1: [event()] });
    await list(client);

    expect(client.calls[0].path).toBe('events');
    expect(client.calls[0].params).toMatchObject({
      event_starts_after: '2026-08-21',
      event_ends_before: '2026-09-30',
      page: 1,
      page_size: PAGE_SIZE,
    });
    expect(PAGE_SIZE).toBeGreaterThan(50);
  });

  it('refuses a missing window rather than meeting Clubworx 422', async () => {
    const client = clientWith({ 1: [event()] });
    const result = await list(client, { from: '', to: '' });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('bad-request');
    expect(client.calls).toHaveLength(0);
  });

  it('refuses a window that is not a real pair of days', async () => {
    const client = clientWith({ 1: [event()] });
    expect((await list(client, { from: '2026-02-30' })).reason).toBe('bad-request');
    expect((await list(client, { to: '28/09/2026' })).reason).toBe('bad-request');
    expect(client.calls).toHaveLength(0);
  });

  it('refuses a window that runs backwards', async () => {
    const client = clientWith({ 1: [event()] });
    const result = await list(client, { from: '2026-09-30', to: '2026-08-21' });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('bad-request');
    expect(client.calls).toHaveLength(0);
  });

  it('carries only the fields the picker needs, and never the instructor', async () => {
    const client = clientWith({ 1: [event()] });
    const result = await list(client);
    const row = result.events[0];

    // §8 pre-ticks same-name, same-location events, so location travels.
    expect(row).toMatchObject({
      event_id: 101,
      event_name: 'School Session',
      location_name: 'Main Gym',
      spaces_available: 20,
      event_full: false,
    });
    // A staff member's name answers no question the picker asks.
    expect(row).not.toHaveProperty('instructor_name');
    expect(row).not.toHaveProperty('event_description');
  });

  it('annotates every event with its lead time rather than dropping any', async () => {
    const client = clientWith({
      1: [
        event({ event_id: 1 }),
        event({ event_id: 2, event_start_at: '2026-08-21T12:00:00.000Z' }),
        event({ event_id: 3, spaces_available: 0, event_full: true }),
      ],
    });
    const result = await list(client);
    const byId = Object.fromEntries(result.events.map(e => [e.event_id, e]));

    expect(Object.keys(byId).map(Number).sort()).toEqual([1, 2, 3]);
    expect(byId[1].bookable).toBe(true);
    // Too soon: shown, with the reason attached, never silently removed (D9).
    expect(byId[2].bookable).toBe(false);
    expect(byId[2].lead.withinLeadTime).toBe(true);
    // Full: shown with its zero beside it, because that number has been wrong in
    // both directions and §11 warns rather than blocks.
    expect(byId[3].bookable).toBe(false);
  });

  it('sorts by start time, so the picker reads as a timetable', async () => {
    const client = clientWith({
      1: [
        event({ event_id: 2, event_start_at: '2026-09-01T01:00:00.000Z' }),
        event({ event_id: 1, event_start_at: '2026-08-28T01:00:00.000Z' }),
      ],
    });
    const result = await list(client);
    expect(result.events.map(e => e.event_id)).toEqual([1, 2]);
  });

  it('pages past a full page and reports the walk as complete', async () => {
    const client = clientWith({ 1: filler(PAGE_SIZE), 2: [event({ event_id: 7 })] });
    const result = await list(client);

    expect(result.ok).toBe(true);
    expect(result.pages).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.total).toBe(PAGE_SIZE + 1);
  });

  it('stops on a short page — the only end-of-list signal Clubworx offers', async () => {
    const client = clientWith({ 1: filler(3) });
    await list(client);
    expect(client.calls).toHaveLength(1);
  });

  it('flags truncation when the walk hit its ceiling still full', async () => {
    const everyPageFull = Object.fromEntries(
      Array.from({ length: MAX_PAGES }, (_, i) => [i + 1, filler(PAGE_SIZE)]),
    );
    const result = await list(clientWith(everyPageFull));

    // Still an answer — the picker shows what it has and says the window needs
    // narrowing. Silence is what #51 warns about, not incompleteness.
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
  });

  it('filters by name here, not upstream, and reports both counts', async () => {
    const client = clientWith({
      1: [
        event({ event_id: 1, event_name: 'School Session' }),
        event({ event_id: 2, event_name: 'Open Climb' }),
        event({ event_id: 3, event_name: 'after-school session' }),
      ],
    });
    const result = await list(client, { q: 'SCHOOL' });

    expect(result.events.map(e => e.event_id)).toEqual([1, 3]);
    expect(result.total).toBe(3);
    expect(result.q).toBe('SCHOOL');
    // The filter is not a Clubworx parameter — no name filter is measured on
    // this endpoint, so sending one would be a guess that silently returns less.
    expect(client.calls[0].params).not.toHaveProperty('q');
  });

  it('skips a row with no event_id, which could not be booked anyway', async () => {
    const client = clientWith({ 1: [event({ event_id: null }), event({ event_id: 5 })] });
    const result = await list(client);
    expect(result.events.map(e => e.event_id)).toEqual([5]);
  });

  it('tells a throttle apart from every other upstream failure', async () => {
    const client = clientWith({}, { ok: false, status: 429, body: null, bodyText: 'slow down' });
    const result = await list(client);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('throttled');
    expect(result.upstreamStatus).toBe(429);
  });

  it('refuses a 200 whose body is not a list of events', async () => {
    const client = clientWith({}, { body: { events: [] } });
    const result = await list(client);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('upstream-error');
  });
});

describe('resolveEvent', () => {
  const resolve = (client, over = {}) => resolveEvent({ client, eventId: '101', now: NOW, ...over });

  it('asks for the event by id, url-encoded into the path', async () => {
    const client = clientWith({ 'events/a%2Fb': event({ event_id: 'a/b' }) });
    const result = await resolve(client, { eventId: 'a/b' });

    expect(client.calls[0].path).toBe('events/a%2Fb');
    expect(result.ok).toBe(true);
    expect(result.via).toBe('direct');
  });

  it('accepts a single-event array as well as a bare object', async () => {
    const client = clientWith({ 'events/101': [event()] });
    const result = await resolve(client);

    expect(result.ok).toBe(true);
    expect(result.event.event_id).toBe(101);
  });

  it('returns the name, date and spaces so staff can confirm the event', async () => {
    const client = clientWith({ 'events/101': event() });
    const result = await resolve(client);

    expect(result.event).toMatchObject({
      event_id: 101,
      event_name: 'School Session',
      event_start_at: '2026-08-28T01:00:00.000Z',
      spaces_available: 20,
    });
    expect(result.event.lead.withinLeadTime).toBe(false);
  });

  it('refuses a list that is not one matching event, rather than taking the first', async () => {
    // If `events/:id` is not a route, Clubworx may answer with the collection.
    // Picking row one out of that would confirm the wrong class to an operator.
    const client = clientWith({ 'events/101': [event({ event_id: 8 }), event({ event_id: 9 })] });
    const result = await resolve(client);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('event-not-found');
  });

  it('refuses an event whose id is not the one that was asked for', async () => {
    const client = clientWith({ 'events/101': event({ event_id: 999 }) });
    expect((await resolve(client)).ok).toBe(false);
  });

  it('falls back to the window when the direct lookup does not resolve', async () => {
    const client = {
      calls: [],
      get: async (path, params = {}) => {
        client.calls.push({ path, params });
        const base = { ok: true, status: 200, ms: 1, body: [], message: null, bodyText: null, networkError: false };
        if (path !== 'events') return { ...base, ok: false, status: 404, body: null };
        return { ...base, body: params.page === 1 ? [event({ event_id: 42 })] : [] };
      },
    };
    const result = await resolve(client, { eventId: '42', from: '2026-08-21', to: '2026-09-30' });

    expect(result.ok).toBe(true);
    expect(result.via).toBe('window');
    expect(result.event.event_id).toBe(42);
  });

  it('refuses when neither path resolves, naming the id it was given', async () => {
    const client = clientWith({});
    const result = await resolve(client, { eventId: '404' });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('event-not-found');
    expect(result.message).toContain('404');
  });

  it('refuses a blank id without calling Clubworx', async () => {
    const client = clientWith({});
    const result = await resolve(client, { eventId: '  ' });

    expect(result.reason).toBe('bad-request');
    expect(client.calls).toHaveLength(0);
  });

  it('passes a throttle through rather than reading it as a missing event', async () => {
    const client = clientWith({}, { ok: false, status: 429, body: null, bodyText: 'slow down' });
    const result = await resolve(client);

    expect(result.reason).toBe('throttled');
    expect(result.upstreamStatus).toBe(429);
  });
});
