import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from '../src/index.js';

const env = {
  ALLOWED_ORIGIN: 'https://ujstaff.happyk.au',
  DEPUTY_URL: 'https://example.au.deputy.com/api/v1',
  DEPUTY_TOKEN: 'test-token',
};

const NOW = Date.UTC(2026, 7, 5, 3, 0, 0);
const DAY = 86400000;

const call = (extraEnv = {}) =>
  worker.fetch(new Request('https://ujstaff.happyk.au/api/roster'), { ...env, ...extraEnv });

/** A Deputy parent roster record with the metadata shape the Worker reads. */
const parent = (id, start) => ({
  Id: id,
  StartTime: start,
  EndTime: start + 3600,
  _DPMetaData: {
    EmployeeInfo: { DisplayName: `Staff ${id}` },
    OperationalUnitInfo: { OperationalUnitName: 'Front of House' },
  },
});

/** A micro-schedule child segment hanging off a parent record. */
const child = (id, parentId, start) => ({
  Id: id,
  ParentId: parentId,
  StartTime: start,
  EndTime: start + 1800,
  _DPMetaData: {
    EmployeeInfo: { DisplayName: `Staff ${parentId}` },
    OperationalUnitInfo: { OperationalUnitName: 'Coach' },
  },
});

const isChildQuery = body => Boolean(JSON.parse(body).search.s3);

/**
 * Stand in for Deputy's Roster/QUERY. Serves `parents`/`children` in pages of
 * 500 — the cap the real Resource API enforces and will not raise — honouring
 * the `start` offset the Worker sends.
 */
function stubDeputy({ parents = [], children = [] }) {
  const calls = [];
  const handler = vi.fn(async (urlOrReq, init) => {
    const body = init.body;
    calls.push(JSON.parse(body));
    const set = isChildQuery(body) ? children : parents;
    const { start = 0 } = JSON.parse(body);
    return new Response(JSON.stringify(set.slice(start, start + 500)), { status: 200 });
  });
  vi.stubGlobal('fetch', handler);
  return {
    parentCalls: () => calls.filter(c => !c.search.s3),
    childCalls: () => calls.filter(c => c.search.s3),
  };
}

beforeEach(() => vi.useFakeTimers().setSystemTime(NOW));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('/api/roster Deputy window', () => {
  it('queries 60 days back and 30 days forward by default', async () => {
    const deputy = stubDeputy({ parents: [parent(1, NOW / 1000)] });

    const res = await call();

    expect(res.status).toBe(200);
    const { search } = deputy.parentCalls()[0];
    expect(search.s1).toMatchObject({ field: 'StartTime', type: 'ge', data: (NOW - 60 * DAY) / 1000 });
    expect(search.s2).toMatchObject({ field: 'StartTime', type: 'le', data: (NOW + 30 * DAY) / 1000 });
  });

  it('honours the configured window instead of the defaults', async () => {
    const deputy = stubDeputy({ parents: [parent(1, NOW / 1000)] });

    await call({ DEPUTY_WINDOW_PAST_DAYS: '7', DEPUTY_WINDOW_FUTURE_DAYS: '14' });

    const { search } = deputy.parentCalls()[0];
    expect(search.s1.data).toBe((NOW - 7 * DAY) / 1000);
    expect(search.s2.data).toBe((NOW + 14 * DAY) / 1000);
  });
});

describe('/api/roster pagination past the 500-record cap', () => {
  it('pages the parent query until Deputy returns a short page', async () => {
    // 620 records over the 90-day window: one full page plus a remainder.
    const parents = Array.from({ length: 620 }, (_, i) => parent(i + 1, NOW / 1000 + i * 60));
    const deputy = stubDeputy({ parents });

    const res = await call();
    const shifts = await res.json();

    expect(shifts).toHaveLength(620);
    const starts = deputy.parentCalls().map(c => c.start ?? 0);
    expect(starts).toEqual([0, 500]);
  });

  it('pages the child query so micro-scheduled shifts are not truncated', async () => {
    // Every parent is micro-scheduled, so children outnumber the 500 cap too.
    const parents = Array.from({ length: 300 }, (_, i) => parent(i + 1, NOW / 1000 + i * 60));
    const children = parents.flatMap((p, i) => [
      child(10_000 + i * 2, p.Id, p.StartTime),
      child(10_001 + i * 2, p.Id, p.StartTime + 1800),
    ]);
    const deputy = stubDeputy({ parents, children });

    const res = await call();
    const shifts = await res.json();

    // Each parent is replaced by its two child segments, all of them present.
    expect(shifts).toHaveLength(600);
    expect(shifts.every(s => s.role === 'Coach')).toBe(true);
    expect(deputy.childCalls().map(c => c.start ?? 0)).toEqual([0, 500]);
  });

  it('does not make a second request when the first page is short', async () => {
    const deputy = stubDeputy({ parents: [parent(1, NOW / 1000)] });

    await call();

    expect(deputy.parentCalls()).toHaveLength(1);
    expect(deputy.childCalls()).toHaveLength(1);
  });

  it('fails loudly at the page ceiling instead of returning a truncated set', async () => {
    // A Deputy that never returns a short page would otherwise spin forever.
    // Stopping is right; reporting success on a set we know is incomplete is not
    // — that is the silent truncation this whole change exists to remove.
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify(Array.from({ length: 500 }, (_, i) => parent(i + 1, NOW / 1000))), { status: 200 })
    ));

    const res = await call();
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toMatch(/incomplete|too many|ceiling/i);
    // 20 pages each for the parent and child queries, then it gives up.
    expect(globalThis.fetch.mock.calls).toHaveLength(40);
  });
});
