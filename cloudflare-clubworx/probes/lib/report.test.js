import { describe, it, expect } from 'vitest';
import {
  percentile,
  summariseBurst,
  rateLimitHeaders,
  summariseEvents,
  sameIds,
  deriveRateLimit,
  recommendPacing,
  summariseContacts,
  describeIsolation,
} from './report.mjs';

// What a probe is allowed to write down. Everything here is counts, ids, status
// codes and timings — never a row of production data. staff-site is a public
// repo and Clubworx holds ~60,000 real people, so the reporting layer is the
// control that keeps a findings document publishable.

describe('percentile', () => {
  // Nearest rank: index = ceil(p/100 * N), so p50 of ten values is the fifth,
  // not the sixth. No interpolation — every figure reported is a latency that
  // was actually observed, which is what a burst probe wants.
  it('takes the nearest rank, so p50 of ten values is the fifth', () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
  });

  it('returns the single value for a one-sample run', () => {
    expect(percentile([42], 95)).toBe(42);
  });

  it('sorts numerically, not lexically — 100 is not less than 20', () => {
    expect(percentile([100, 20, 3], 100)).toBe(100);
  });

  it('is null for an empty set rather than NaN, which would print as a number', () => {
    expect(percentile([], 50)).toBeNull();
  });
});

describe('summariseBurst', () => {
  const ok = ms => ({ status: 200, ms });

  it('counts responses by status code', () => {
    const s = summariseBurst([ok(10), ok(20), { status: 429, ms: 5 }]);
    expect(s.byStatus).toEqual({ 200: 2, 429: 1 });
  });

  it('reports the index of the first 429, which is how fast a ceiling arrives', () => {
    const s = summariseBurst([ok(10), ok(10), { status: 429, ms: 3 }, { status: 429, ms: 3 }]);
    expect(s.throttled).toBe(2);
    expect(s.firstThrottledIndex).toBe(2);
  });

  it('reports no throttling as null, distinct from index 0', () => {
    // 0 is falsy, so a caller testing `if (firstThrottledIndex)` would read a
    // ceiling hit on the very first call as a clean run. Keep the types apart.
    const s = summariseBurst([ok(10)]);
    expect(s.firstThrottledIndex).toBeNull();
    expect(summariseBurst([{ status: 429, ms: 1 }]).firstThrottledIndex).toBe(0);
  });

  it('summarises latency across the run', () => {
    const s = summariseBurst([ok(100), ok(200), ok(300), ok(400)]);
    expect(s.ms.min).toBe(100);
    expect(s.ms.max).toBe(400);
    expect(s.ms.p50).toBe(200);
  });

  it('counts transport failures separately from HTTP statuses', () => {
    // A dropped connection has no status. Folding it into 5xx would understate
    // the failure mode the burst is looking for.
    const s = summariseBurst([ok(10), { error: 'ECONNRESET', ms: 12 }]);
    expect(s.errors).toEqual({ ECONNRESET: 1 });
    expect(s.byStatus).toEqual({ 200: 1 });
    expect(s.count).toBe(2);
  });

  it('treats any 4xx or 5xx beyond 429 as a failure worth naming', () => {
    const s = summariseBurst([ok(10), { status: 500, ms: 9 }]);
    expect(s.clean).toBe(false);
  });

  it('calls a run clean only when every call was a 2xx', () => {
    expect(summariseBurst([ok(10), ok(20)]).clean).toBe(true);
  });
});

describe('rateLimitHeaders', () => {
  it('picks out the headers a client could self-throttle from', () => {
    const found = rateLimitHeaders({
      'content-type': 'application/json',
      'retry-after': '30',
      'x-ratelimit-remaining': '4',
    });
    expect(found).toEqual({ 'retry-after': '30', 'x-ratelimit-remaining': '4' });
  });

  it('matches case-insensitively and across the spellings in the wild', () => {
    const found = rateLimitHeaders({ 'RateLimit-Limit': '100', 'X-Rate-Limit-Reset': '60' });
    expect(Object.keys(found).sort()).toEqual(['ratelimit-limit', 'x-rate-limit-reset']);
  });

  it('returns an empty object when the API advertises nothing', () => {
    expect(rateLimitHeaders({ 'content-type': 'application/json' })).toEqual({});
  });

  it('accepts a fetch Headers instance, not just a plain object', () => {
    const h = new Headers({ 'Retry-After': '5' });
    expect(rateLimitHeaders(h)).toEqual({ 'retry-after': '5' });
  });
});

describe('summariseEvents', () => {
  const row = (event_id, start) => ({
    event_id,
    event_name: 'Real School Name Yr 5',
    event_start_at: start,
    location_id: 3,
    instructor_name: 'A Real Person',
  });

  it('keeps ids, counts and the field list — never the values', () => {
    const s = summariseEvents([row(30, '2026-08-18T09:00:00.000+08:00')]);
    expect(s.count).toBe(1);
    expect(s.ids).toEqual([30]);
    expect(s.fields).toContain('event_name');
    expect(JSON.stringify(s)).not.toContain('Real School Name');
    expect(JSON.stringify(s)).not.toContain('A Real Person');
  });

  it('reports the date span so a window filter can be checked', () => {
    const s = summariseEvents([
      row(2, '2026-08-20T09:00:00.000+08:00'),
      row(1, '2026-08-18T09:00:00.000+08:00'),
    ]);
    expect(s.earliest).toBe('2026-08-18T09:00:00.000+08:00');
    expect(s.latest).toBe('2026-08-20T09:00:00.000+08:00');
  });

  it('sorts ids so two runs compare directly', () => {
    expect(summariseEvents([row(9, 'x'), row(2, 'x')]).ids).toEqual([2, 9]);
  });

  it('unions the field list across rows, since a null field may be absent on one', () => {
    const s = summariseEvents([{ event_id: 1 }, { event_id: 2, spaces_available: 4 }]);
    expect(s.fields.sort()).toEqual(['event_id', 'spaces_available']);
  });

  it('survives a non-array body, which is what an error page looks like', () => {
    const s = summariseEvents({ error: 'not authorised' });
    expect(s.count).toBe(0);
    expect(s.notAnArray).toBe(true);
  });
});

describe('sameIds', () => {
  it('is true for the same set in any order', () => {
    expect(sameIds([1, 2, 3], [3, 2, 1])).toBe(true);
  });

  it('is false when one set holds an event the other does not', () => {
    // This is the actual question: does a different contact_key change what
    // comes back, or is the parameter ignored and the list gym-wide?
    expect(sameIds([1, 2], [1, 2, 3])).toBe(false);
  });

  it('is true for two empty sets', () => {
    expect(sameIds([], [])).toBe(true);
  });
});

// Clubworx returns no rate-limit headers even while throttling (confirmed under
// live 429s, staff-site#51), so the ceiling can only be described by two
// measurements: how many requests were accepted before the wall, and how long
// the wall lasted. Everything downstream is arithmetic on those two numbers,
// which is why it is here and unit tested rather than inline in the probe.

describe('deriveRateLimit', () => {
  it('reads a quota as requests per minute', () => {
    expect(deriveRateLimit({ allowed: 60, windowMs: 60_000 }).perMinute).toBe(60);
  });

  it('scales a sub-minute window up', () => {
    expect(deriveRateLimit({ allowed: 15, windowMs: 30_000 }).perMinute).toBe(30);
  });

  it('carries the raw measurements through, since the derived figure is an inference', () => {
    const d = deriveRateLimit({ allowed: 60, windowMs: 60_000 });
    expect(d.allowed).toBe(60);
    expect(d.windowMs).toBe(60_000);
  });

  it('refuses a zero or negative window rather than dividing by it', () => {
    expect(() => deriveRateLimit({ allowed: 60, windowMs: 0 })).toThrow(/window/i);
  });

  it('refuses a run that was never throttled — there is no ceiling to derive', () => {
    // A clean run proves the limit is above what was tried, not what it is.
    expect(() => deriveRateLimit({ allowed: 0, windowMs: 60_000 })).toThrow(/allowed/i);
  });
});

describe('recommendPacing', () => {
  it('leaves headroom under the observed ceiling', () => {
    const p = recommendPacing({ allowed: 60, windowMs: 60_000, safety: 0.8 });
    expect(p.perMinute).toBe(48);
    expect(p.gapMs).toBe(1250);
  });

  it('defaults to a conservative safety factor, because the window is inferred', () => {
    expect(recommendPacing({ allowed: 60, windowMs: 60_000 }).perMinute).toBeLessThan(60);
  });

  it('recommends serial requests — concurrency cannot help under a quota', () => {
    // A per-window quota is spent at the same rate by 1 request in flight or 8.
    // Concurrency only changes how fast the wall arrives.
    expect(recommendPacing({ allowed: 60, windowMs: 60_000 }).concurrency).toBe(1);
  });

  it('states what a 90-read lookup would cost at that pace', () => {
    const p = recommendPacing({ allowed: 60, windowMs: 60_000, reads: 90 });
    expect(p.estimatedMsFor).toBe(90 * 1250);
  });
});

describe('summariseContacts', () => {
  // staff-site#49 searches on a partial email, so the responses it summarises
  // contain whoever else happens to match — real people, in a public repo's
  // probe output. Only counts, field names, and keys this probe already knows
  // may survive this function.
  const ours = ['ck-a', 'ck-b'];
  const body = [
    { contact_key: 'ck-a', first_name: 'Ztest', last_name: 'Wayfinder', email: 'noreply+wayfindertest@urbanjungleirc.com' },
    { contact_key: 'ck-real', first_name: 'Katie', last_name: 'Fernsby', email: 'parent@example.com' },
  ];

  it('records no row of production data, whatever came back', () => {
    const json = JSON.stringify(summariseContacts(body, ours));
    expect(json).not.toContain('Katie');
    expect(json).not.toContain('Fernsby');
    expect(json).not.toContain('parent@example.com');
    expect(json).not.toContain('ck-real');
  });

  it('counts everything returned, including rows it may not describe', () => {
    // The count is the answer to "does a partial email match?", so it must
    // include strangers even though their details cannot be written down.
    expect(summariseContacts(body, ours).count).toBe(2);
  });

  it('names which of our own contacts came back', () => {
    expect(summariseContacts(body, ours).ours).toEqual(['ck-a']);
  });

  it('counts the rest as strangers without identifying them', () => {
    expect(summariseContacts(body, ours).strangers).toBe(1);
  });

  it('lists the field names, which are schema and not data', () => {
    expect(summariseContacts(body, ours).fields).toContain('contact_key');
  });

  it('flags a body that is not a list rather than pretending it was empty', () => {
    // A 422 or a throttle answers with an object or HTML. "0 contacts" and
    // "the request failed" are different answers to question 3.
    expect(summariseContacts({ error: 'nope' }, ours).notAnArray).toBe(true);
    expect(summariseContacts(null, ours).count).toBe(0);
  });
});

describe('describeIsolation', () => {
  // Question 3: does email=noreply+<tag> isolate one school, or does it return
  // every noreply+ contact? The whole school-marking scheme rests on this.
  it('confirms isolation when a tag returns its own contacts and no others', () => {
    const v = describeIsolation({ returned: ['ck-a', 'ck-b'], expected: ['ck-a', 'ck-b'], excluded: ['ck-c'] });
    expect(v.isolated).toBe(true);
    expect(v.missing).toEqual([]);
    expect(v.crossTag).toEqual([]);
  });

  it('reports a tag that leaks contacts belonging to another tag', () => {
    const v = describeIsolation({ returned: ['ck-a', 'ck-b', 'ck-c'], expected: ['ck-a', 'ck-b'], excluded: ['ck-c'] });
    expect(v.isolated).toBe(false);
    expect(v.crossTag).toEqual(['ck-c']);
  });

  it('reports a tag that fails to return its own contacts', () => {
    // Just as fatal as leaking, and a different failure: the marker would not
    // find the school it marked.
    const v = describeIsolation({ returned: ['ck-a'], expected: ['ck-a', 'ck-b'], excluded: ['ck-c'] });
    expect(v.isolated).toBe(false);
    expect(v.missing).toEqual(['ck-b']);
  });

  it('is not isolated when nothing came back at all', () => {
    const v = describeIsolation({ returned: [], expected: ['ck-a'], excluded: [] });
    expect(v.isolated).toBe(false);
  });

  it('says "not applicable" when the endpoint holds none of our contacts', () => {
    // A contact created as a prospect does not appear under /members at all.
    // Reporting that as an isolation failure blames the search for the contact
    // type being elsewhere — and #49's answer would read as a broken marker.
    const v = describeIsolation({
      returned: [],
      expected: ['ck-a'],
      excluded: [],
      endpointHoldsOurs: false,
    });
    expect(v.applicable).toBe(false);
    expect(v.isolated).toBeNull();
  });

  it('still judges isolation on an endpoint that does hold our contacts', () => {
    const v = describeIsolation({
      returned: ['ck-a'],
      expected: ['ck-a'],
      excluded: ['ck-c'],
      endpointHoldsOurs: true,
    });
    expect(v.applicable).toBe(true);
    expect(v.isolated).toBe(true);
  });
});
