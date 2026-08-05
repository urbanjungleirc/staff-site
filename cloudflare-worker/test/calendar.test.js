import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../src/index.js';

// The calendar route needs no Deputy or GitHub configuration — that independence
// is itself part of the contract and is asserted below.
const env = { ALLOWED_ORIGIN: 'https://ujstaff.happyk.au' };

const DAY = 86400000;

/**
 * The live WA 2026 feed, captured 2026-08-05. Thirteen events, an exact match
 * to the official wa.gov.au list — including both Anzac Day dates and both
 * Boxing Day dates. Refetch it rather than hand-editing if it ever needs
 * updating; hand-written holiday data is how the substitute-day traps get lost.
 */
const WA_2026_ICS = readFileSync(new URL('./fixtures/wa-holidays-2026.ics', import.meta.url), 'utf8');

/** A VCALENDAR carrying just the events a test cares about. */
function icsWith(events) {
  const body = events
    .map(
      e => `BEGIN:VEVENT\r\nDTSTART;VALUE=DATE:${e.start}\r\n${e.end ? `DTEND;VALUE=DATE:${e.end}\r\n` : ''}SUMMARY:${e.name}\r\nEND:VEVENT`
    )
    .join('\r\n');
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${body}\r\nEND:VCALENDAR\r\n`;
}

/** Midday in Perth on `ymd`, so the Perth civil date is unambiguous. */
const atPerth = ymd => Date.parse(`${ymd}T12:00:00+08:00`);

const realFetch = globalThis.fetch;
const realCaches = globalThis.caches;

let upstream;

/**
 * Stub the holiday feed. Upstream is the only network the route touches, so
 * every test runs offline and nothing internal is exported to make it testable.
 */
function stubUpstream(impl) {
  upstream = vi.fn(impl ?? (async () => new Response(WA_2026_ICS, { status: 200 })));
  globalThis.fetch = upstream;
}

/**
 * A stand-in for the platform cache. The route reaches for `caches.default`
 * and nothing else, so a Map behind `match`/`put` is the whole surface.
 */
function stubCaches() {
  const store = new Map();
  globalThis.caches = {
    default: {
      async match(key) {
        return store.get(String(key))?.clone();
      },
      async put(key, res) {
        store.set(String(key), res.clone());
      },
    },
  };
  return store;
}

let cacheStore;

async function get(url = 'https://ujstaff.happyk.au/api/calendar', extraEnv = {}, init) {
  return worker.fetch(new Request(url, init), { ...env, ...extraEnv });
}

/** Fetch the calendar as it would be served on the Perth date `ymd`. */
async function calendarOn(ymd, extraEnv = {}) {
  vi.setSystemTime(atPerth(ymd));
  const res = await get(undefined, extraEnv);
  return { res, body: await res.json() };
}

/** How a given date is described when viewed from `viewedFrom`. */
async function dayOn(viewedFrom, date) {
  const { body } = await calendarOn(viewedFrom);
  return body.calendar[date];
}

beforeEach(() => {
  vi.useFakeTimers();
  stubUpstream();
  cacheStore = stubCaches();
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = realFetch;
  globalThis.caches = realCaches;
});

describe('/api/calendar response shape', () => {
  it('serves a per-date map spanning 30 days back and 90 forward', async () => {
    const { res, body } = await calendarOn('2026-08-05');

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/application\/json/);
    const keys = Object.keys(body.calendar).sort();
    expect(keys[0]).toBe('2026-07-06'); // 30 days back
    expect(keys[keys.length - 1]).toBe('2026-11-03'); // 90 days forward
    expect(keys).toHaveLength(121);
  });

  it('carries a public holiday field on every date', async () => {
    const { body } = await calendarOn('2026-08-05');

    expect(Object.values(body.calendar).every(d => 'publicHoliday' in d)).toBe(true);
  });

  it('reports how far the term table reaches', async () => {
    const { body } = await calendarOn('2026-08-05');

    // Last snapped day of 2031 term 4 (official end Wed 17 Dec, snapped to Sunday).
    expect(body.meta.termTableCoversTo).toBe('2031-12-21');
  });

  it('does not need Deputy configured — a rostering outage must not hide term context', async () => {
    // `env` deliberately carries no DEPUTY_URL or DEPUTY_TOKEN.
    const { res, body } = await calendarOn('2026-08-05');

    expect(res.status).toBe(200);
    expect(body.calendar['2026-08-05'].state).toBe('term');
  });

  it('rejects non-GET methods', async () => {
    vi.setSystemTime(atPerth('2026-08-05'));

    const res = await get(undefined, {}, { method: 'POST' });

    expect(res.status).toBe(405);
  });
});

describe('term classification', () => {
  // The worked examples agreed in the design record (issue #8).
  it.each([
    ['2026-04-02', 'Thu', { state: 'term', term: 1, week: 9, weeksInTerm: 9 }],
    ['2026-04-03', 'Fri', { state: 'term', term: 1, week: 9, weeksInTerm: 9 }],
    ['2026-04-05', 'Sun', { state: 'term', term: 1, week: 9, weeksInTerm: 9 }],
    ['2026-04-06', 'Mon', { state: 'break' }],
    ['2026-08-05', 'Wed', { state: 'term', term: 3, week: 3, weeksInTerm: 10 }],
    ['2026-09-25', 'Fri', { state: 'term', term: 3, week: 10, weeksInTerm: 10 }],
    ['2026-09-27', 'Sun', { state: 'term', term: 3, week: 10, weeksInTerm: 10 }],
    ['2026-09-28', 'Mon', { state: 'break' }],
  ])('describes %s (%s) as agreed', async (date, _dow, expected) => {
    expect(await dayOn(date, date)).toMatchObject(expected);
  });

  it('starts week 1 on the Monday before a mid-week term start', async () => {
    // 2028 term 1 officially starts Wednesday 2 February.
    const { body } = await calendarOn('2028-02-02');

    expect(body.calendar['2028-01-30']).toMatchObject({ state: 'break' }); // Sunday
    expect(body.calendar['2028-01-31']).toMatchObject({ state: 'term', term: 1, week: 1 }); // Monday
    expect(body.calendar['2028-02-02']).toMatchObject({ state: 'term', term: 1, week: 1 }); // official start
    expect(body.calendar['2028-02-07']).toMatchObject({ state: 'term', term: 1, week: 2 });
  });

  it('runs the final week through Sunday when a term ends on a Thursday', async () => {
    // 2026 term 1 officially ends Thursday 2 April.
    const { body } = await calendarOn('2026-04-02');

    expect(body.calendar['2026-04-04']).toMatchObject({ state: 'term', term: 1, week: 9, weeksInTerm: 9 }); // Sat
    expect(body.calendar['2026-04-05']).toMatchObject({ state: 'term', term: 1, week: 9, weeksInTerm: 9 }); // Sun
    expect(body.calendar['2026-04-06']).toMatchObject({ state: 'break' }); // Mon
  });

  it('runs the final week through Sunday when a term ends on a Friday', async () => {
    // 2026 term 3 officially ends Friday 25 September; the Saturday is still term.
    const { body } = await calendarOn('2026-09-25');

    expect(body.calendar['2026-09-26']).toMatchObject({ state: 'term', term: 3, week: 10 }); // Sat
    expect(body.calendar['2026-09-27']).toMatchObject({ state: 'term', term: 3, week: 10 }); // Sun
    expect(body.calendar['2026-09-28']).toMatchObject({ state: 'break' }); // Mon
  });

  it.each([
    ['a 9-week term', '2026-02-02', { term: 1, weeksInTerm: 9 }],
    ['a 10-week term', '2026-07-20', { term: 3, weeksInTerm: 10 }],
    ['an 11-week term', '2026-04-20', { term: 2, weeksInTerm: 11 }],
  ])('reports the true length of %s', async (_label, date, expected) => {
    expect(await dayOn(date, date)).toMatchObject({ state: 'term', ...expected });
  });

  it('numbers weeks from 1 to the term length with no gaps', async () => {
    // 2026 term 1 — the 9-week case, viewed whole.
    const { body } = await calendarOn('2026-03-01');
    const weeks = Object.entries(body.calendar)
      .filter(([, d]) => d.state === 'term' && d.term === 1)
      .map(([, d]) => d.week);

    expect(new Set(weeks)).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]));
  });
});

describe('school breaks', () => {
  it('names the next term and the date it starts', async () => {
    const { body } = await calendarOn('2026-09-28');

    expect(body.calendar['2026-09-28']).toMatchObject({
      state: 'break',
      nextTerm: 4,
      nextTermStart: '2026-10-12',
    });
  });

  it('points at the first day it will itself call term, not the official start', async () => {
    // 2028 term 1 officially starts Wednesday 2 February, but UJ week 1 opens
    // Monday 31 January — so that is the date the break must advertise.
    const { body } = await calendarOn('2028-01-20');

    expect(body.calendar['2028-01-20']).toMatchObject({ state: 'break', nextTerm: 1, nextTermStart: '2028-01-31' });
    expect(body.calendar['2028-01-31'].state).toBe('term');
  });

  it('is exactly 14 days, or 42 across summer, everywhere in the table', async () => {
    // Harvested through the HTTP boundary a window at a time, then stitched.
    const seen = new Map();
    for (let t = atPerth('2025-03-01'); t <= atPerth('2031-11-01'); t += 90 * DAY) {
      vi.setSystemTime(t);
      const { calendar } = await (await get()).json();
      for (const [date, day] of Object.entries(calendar)) seen.set(date, day.state);
    }

    const states = [...seen.keys()].sort().map(date => seen.get(date));
    const runs = [];
    for (let i = 0; i < states.length; ) {
      if (states[i] !== 'break') { i++; continue; }
      let end = i;
      while (end < states.length && states[end] === 'break') end++;
      // Only a run with term on both sides is a whole break; one touching the
      // harvest edge is truncated and proves nothing.
      if (states[i - 1] === 'term' && states[end] === 'term') runs.push(end - i);
      i = end;
    }

    expect(runs.length).toBeGreaterThanOrEqual(27); // 4 terms × 7 years, less the open ends
    expect(runs.filter(n => n === 42)).not.toHaveLength(0); // the summer breaks
    for (const length of runs) expect([14, 42]).toContain(length);
  });
});

describe('staleness', () => {
  it('marks a date past the end of the term table unknown rather than guessing', async () => {
    const { res, body } = await calendarOn('2032-01-05');

    expect(res.status).toBe(200);
    expect(body.calendar['2032-01-05']).toMatchObject({ state: 'unknown', publicHoliday: null });
    expect(body.calendar['2032-01-05'].term).toBeUndefined();
  });

  it('marks a date before the start of the term table unknown', async () => {
    const { res, body } = await calendarOn('2025-01-15');

    expect(res.status).toBe(200);
    expect(body.calendar['2024-12-20'].state).toBe('unknown');
  });

  it('flags the table as ageing once it is within six months of running out', async () => {
    // The table covers to 2031-12-21.
    expect((await calendarOn('2031-06-20')).body.meta.termTableAgeing).toBe(false);
    expect((await calendarOn('2031-06-21')).body.meta.termTableAgeing).toBe(true);
  });

  it('does not flag ageing while the table has years left', async () => {
    const { body } = await calendarOn('2026-08-05');

    expect(body.meta.termTableAgeing).toBe(false);
  });
});

describe('public holidays', () => {
  it('names the holiday on the date it falls', async () => {
    expect(await dayOn('2026-09-25', '2026-09-28')).toMatchObject({
      publicHoliday: { name: "King's Birthday" },
    });
  });

  it('leaves an ordinary day empty', async () => {
    expect((await dayOn('2026-08-05', '2026-08-05')).publicHoliday).toBeNull();
  });

  it('shows the holiday alongside term context, never instead of it', async () => {
    // 【PUBLIC HOLIDAY】Anzac Day · Term 2 · Wk 2 of 11 — the worked example.
    expect(await dayOn('2026-04-27', '2026-04-27')).toMatchObject({
      state: 'term',
      term: 2,
      week: 2,
      weeksInTerm: 11,
      publicHoliday: { name: 'Anzac Day' },
    });
  });

  it('shows the holiday alongside a school break too', async () => {
    expect(await dayOn('2026-09-28', '2026-09-28')).toMatchObject({
      state: 'break',
      nextTerm: 4,
      publicHoliday: { name: "King's Birthday" },
    });
  });

  it('keeps both Anzac Day dates — substitute days are not deduplicated by name', async () => {
    const { body } = await calendarOn('2026-04-25');

    expect(body.calendar['2026-04-25'].publicHoliday).toEqual({ name: 'Anzac Day' }); // Saturday
    expect(body.calendar['2026-04-26'].publicHoliday).toBeNull(); // Sunday, not a holiday
    expect(body.calendar['2026-04-27'].publicHoliday).toEqual({ name: 'Anzac Day' }); // substitute Monday
  });

  it('keeps both Boxing Day dates', async () => {
    const { body } = await calendarOn('2026-12-20');

    expect(body.calendar['2026-12-26'].publicHoliday).toEqual({ name: 'Boxing Day' }); // Saturday
    expect(body.calendar['2026-12-27'].publicHoliday).toBeNull(); // Sunday, not a holiday
    expect(body.calendar['2026-12-28'].publicHoliday).toEqual({ name: 'Boxing Day' }); // substitute Monday
  });

  it('keeps Easter Sunday, which is gazetted in WA', async () => {
    const { body } = await calendarOn('2026-04-05');

    expect(body.calendar['2026-04-03'].publicHoliday).toEqual({ name: 'Good Friday' });
    expect(body.calendar['2026-04-05'].publicHoliday).toEqual({ name: 'Easter Sunday' });
    expect(body.calendar['2026-04-06'].publicHoliday).toEqual({ name: 'Easter Monday' });
  });

  it('asks upstream only for gazetted public holidays in WA', async () => {
    await calendarOn('2026-08-05');

    const requested = new URL(upstream.mock.calls[0][0]);
    expect(requested.searchParams.get('holidayType')).toBe('public_holiday');
    expect(requested.searchParams.get('country')).toBe('aus');
    expect(requested.searchParams.get('region')).toBe('wa');
  });

  it("keeps the feed's required trailing slash, which a redirect would otherwise eat", async () => {
    await calendarOn('2026-08-05');

    expect(new URL(upstream.mock.calls[0][0]).pathname).toMatch(/\/$/);
  });

  it('requests a range wide enough to cover the whole window it serves', async () => {
    const { body } = await calendarOn('2026-08-05');

    const requested = new URL(upstream.mock.calls[0][0]);
    const asYmd = ddmmyyyy => ddmmyyyy.split('-').reverse().join('-');
    const dates = Object.keys(body.calendar).sort();
    expect(asYmd(requested.searchParams.get('fromDate')) <= dates[0]).toBe(true);
    expect(asYmd(requested.searchParams.get('toDate')) >= dates[dates.length - 1]).toBe(true);
  });

  it('treats an all-day end date as exclusive across a multi-day event', async () => {
    stubUpstream(async () => new Response(icsWith([{ start: '20260810', end: '20260813', name: 'Long Weekend' }])));

    const { body } = await calendarOn('2026-08-05');

    expect(body.calendar['2026-08-09'].publicHoliday).toBeNull();
    expect(body.calendar['2026-08-10'].publicHoliday).toEqual({ name: 'Long Weekend' });
    expect(body.calendar['2026-08-12'].publicHoliday).toEqual({ name: 'Long Weekend' });
    expect(body.calendar['2026-08-13'].publicHoliday).toBeNull(); // the exclusive end
  });

  it('treats a single-day event as exactly one day', async () => {
    // Christmas Day's DTEND is Boxing Day. Off by one here and Christmas eats it.
    const { body } = await calendarOn('2026-12-20');

    expect(body.calendar['2026-12-25'].publicHoliday).toEqual({ name: 'Christmas Day' });
    expect(body.calendar['2026-12-26'].publicHoliday).toEqual({ name: 'Boxing Day' });
  });

  it('records when the holiday data was fetched', async () => {
    const { body } = await calendarOn('2026-08-05');

    expect(body.meta).toMatchObject({ holidaysAvailable: true, holidaysStale: false });
    expect(body.meta.holidaysFetchedAt).toBe(new Date(atPerth('2026-08-05')).toISOString());
  });
});

describe('holiday caching', () => {
  it('fetches upstream once per Perth day, however many callers ask', async () => {
    await calendarOn('2026-08-05');
    await calendarOn('2026-08-05');
    await calendarOn('2026-08-05');

    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('refetches when the Perth date rolls over', async () => {
    await calendarOn('2026-08-05');
    await calendarOn('2026-08-06');

    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it('keys the cache by the Perth date, since the window it serves rolls daily', async () => {
    await calendarOn('2026-08-05');
    await calendarOn('2026-08-06');

    const keys = [...cacheStore.keys()];
    expect(keys.some(k => k.includes('2026-08-05'))).toBe(true);
    expect(keys.some(k => k.includes('2026-08-06'))).toBe(true);
  });
});

describe('holiday degradation', () => {
  const dead = async () => {
    throw new TypeError('network unreachable');
  };

  it('serves the previous day’s cached holidays, flagged stale, when upstream fails', async () => {
    await calendarOn('2026-09-25'); // warms the cache
    stubUpstream(dead);

    const { res, body } = await calendarOn('2026-09-26');

    expect(res.status).toBe(200);
    expect(body.meta).toMatchObject({ holidaysAvailable: true, holidaysStale: true });
    expect(body.calendar['2026-09-28'].publicHoliday).toEqual({ name: "King's Birthday" });
    // Stamped when it was actually fetched, not when it was served.
    expect(body.meta.holidaysFetchedAt).toBe(new Date(atPerth('2026-09-25')).toISOString());
  });

  it('marks holidays unavailable but still returns term context when nothing is cached', async () => {
    stubUpstream(dead);

    const { res, body } = await calendarOn('2026-09-28');

    expect(res.status).toBe(200);
    expect(body.meta).toMatchObject({ holidaysAvailable: false, holidaysStale: false });
    expect(body.meta.holidaysFetchedAt).toBeNull();
    // The whole point: term context does not depend on the holiday feed.
    expect(body.calendar['2026-09-28']).toMatchObject({ state: 'break', nextTerm: 4 });
    expect(body.calendar['2026-10-12']).toMatchObject({ state: 'term', term: 4, week: 1, weeksInTerm: 10 });
    expect(body.calendar['2026-09-28'].publicHoliday).toBeNull();
  });

  it('treats an upstream error status as a failure rather than parsing the error page', async () => {
    stubUpstream(async () => new Response('<html>Bad Gateway</html>', { status: 502 }));

    const { body } = await calendarOn('2026-09-28');

    expect(body.meta.holidaysAvailable).toBe(false);
    expect(body.calendar['2026-09-28'].state).toBe('break');
  });

  it('treats a feed with no events as unusable rather than as "no holidays"', async () => {
    await calendarOn('2026-09-25'); // warms the cache
    stubUpstream(async () => new Response('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n'));

    const { body } = await calendarOn('2026-09-26');

    expect(body.meta.holidaysStale).toBe(true);
    expect(body.calendar['2026-09-28'].publicHoliday).toEqual({ name: "King's Birthday" });
  });

  it('never lets a holiday failure change term classification', async () => {
    const healthy = await calendarOn('2026-08-05');
    stubUpstream(dead);
    cacheStore = stubCaches(); // cold, so the failure has nothing to fall back on
    const broken = await calendarOn('2026-08-05');

    const stripHolidays = body =>
      Object.fromEntries(Object.entries(body.calendar).map(([date, { publicHoliday, ...rest }]) => [date, rest]));
    expect(stripHolidays(broken.body)).toEqual(stripHolidays(healthy.body));
  });
});
