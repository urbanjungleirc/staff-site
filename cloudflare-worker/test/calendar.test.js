import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../src/index.js';

// The calendar route needs no Deputy or GitHub configuration — that independence
// is itself part of the contract and is asserted below.
const env = { ALLOWED_ORIGIN: 'https://ujstaff.happyk.au' };

const DAY = 86400000;

/** Midday in Perth on `ymd`, so the Perth civil date is unambiguous. */
const atPerth = ymd => Date.parse(`${ymd}T12:00:00+08:00`);

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

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

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

  it('leaves the public holiday field empty for every date', async () => {
    const { body } = await calendarOn('2026-08-05');

    expect(Object.values(body.calendar).every(d => d.publicHoliday === null)).toBe(true);
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
