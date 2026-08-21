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
  classifyWrite,
  schemeCollapses,
  summariseBookings,
  describeBookingRequirement,
  describeDuplicateBooking,
  describeCancellation,
  describeMemberCreation,
  describeCreatedPass,
  describeEventById,
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

describe('classifyWrite', () => {
  // Two questions about a write that are not the same question: did a contact
  // come into existence, and did the server tell us why not. Clubworx cannot
  // delete contacts through the API, so "might exist" has to be treated as
  // "exists" — the cleanup list is the only record anyone gets.

  it('treats a 2xx as created', () => {
    const v = classifyWrite({ status: 200 });
    expect(v.outcome).toBe('created');
    expect(v.mayExist).toBe(true);
    expect(v.conclusive).toBe(true);
  });

  it('accepts any 2xx, not just 201', () => {
    // Clubworx answers 200 on create. A client checking for 201 would read
    // every successful write as a failure.
    expect(classifyWrite({ status: 201 }).outcome).toBe('created');
    expect(classifyWrite({ status: 200 }).outcome).toBe('created');
  });

  it('treats a 4xx as a conclusive rejection that created nothing', () => {
    const v = classifyWrite({ status: 422 });
    expect(v.outcome).toBe('rejected');
    expect(v.mayExist).toBe(false);
    expect(v.conclusive).toBe(true);
  });

  it('treats a transport failure as "may exist", never as a rejection', () => {
    // The request may have been honoured and the response lost. This is the
    // one case where a permanent contact exists and nobody has its key.
    const v = classifyWrite({ status: null, error: 'ECONNRESET' });
    expect(v.outcome).toBe('failed');
    expect(v.mayExist).toBe(true);
    expect(v.conclusive).toBe(false);
  });

  it('treats a 5xx as "may exist" too', () => {
    const v = classifyWrite({ status: 500 });
    expect(v.mayExist).toBe(true);
    expect(v.conclusive).toBe(false);
  });

  it('treats a local identity refusal as nothing having been sent', () => {
    const v = classifyWrite({ status: null, refused: 'not Ztest' });
    expect(v.outcome).toBe('refused');
    expect(v.mayExist).toBe(false);
    expect(v.conclusive).toBe(false);
  });
});

describe('schemeCollapses', () => {
  // #49: "If plus-addressing is rejected, or email turns out to be
  // unique-constrained, the marking decision COLLAPSES ... Say so explicitly
  // rather than inventing a workaround." Only a conclusive rejection means
  // that. A timeout means try again, and saying "collapsed" to a timeout
  // invents the very conclusion the ticket asked to be stated only when true.
  const rejected = { outcome: 'rejected', conclusive: true };
  const failed = { outcome: 'failed', conclusive: false };
  const created = { outcome: 'created', conclusive: true };

  it('does not collapse when both writes were accepted', () => {
    expect(schemeCollapses({ plus: created, duplicate: created }).collapsed).toBe(false);
  });

  it('collapses when the plus-addressed write was rejected', () => {
    const v = schemeCollapses({ plus: rejected, duplicate: null });
    expect(v.collapsed).toBe(true);
    expect(v.reason).toMatch(/plus/i);
  });

  it('collapses when a duplicate email was rejected', () => {
    const v = schemeCollapses({ plus: created, duplicate: rejected });
    expect(v.collapsed).toBe(true);
    expect(v.reason).toMatch(/unique/i);
  });

  it('does NOT collapse on a timeout or a server error', () => {
    expect(schemeCollapses({ plus: created, duplicate: failed }).collapsed).toBe(false);
    expect(schemeCollapses({ plus: failed, duplicate: null }).collapsed).toBe(false);
  });

  it('reports inconclusive rather than pretending a failure was an answer', () => {
    const v = schemeCollapses({ plus: created, duplicate: failed });
    expect(v.inconclusive).toBe(true);
  });

  it('is neither collapsed nor inconclusive when nothing was attempted', () => {
    // A re-run creates nothing because the contacts already exist. That is not
    // an inconclusive result, it is a run with no writes in it.
    const v = schemeCollapses({ plus: null, duplicate: null });
    expect(v.collapsed).toBe(false);
    expect(v.inconclusive).toBe(false);
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

describe('summariseBookings', () => {
  const OURS = 'ck-probe-a';

  it('counts a row with no contact_key as ours, since the query was already scoped', () => {
    const v = summariseBookings([{ booking_id: 'bk-1' }, { booking_id: 'bk-2' }], [OURS]);
    expect(v.ours).toBe(2);
    expect(v.strangers).toBe(0);
    expect(v.ids).toEqual(['bk-1', 'bk-2']);
  });

  it('counts a row belonging to somebody else without recording it', () => {
    // /events ignored contact_key entirely (#51) while the reference called it
    // required, so a scoped endpoint is not something to take on trust.
    const v = summariseBookings(
      [{ booking_id: 'bk-1', contact_key: OURS }, { booking_id: 'bk-9', contact_key: 'ck-real' }],
      [OURS],
    );
    expect(v.ours).toBe(1);
    expect(v.strangers).toBe(1);
    expect(v.ids).toEqual(['bk-1']);
    expect(JSON.stringify(v)).not.toContain('bk-9');
  });

  it('reports field names without values', () => {
    const v = summariseBookings([{ booking_id: 'bk-1', event_name: 'Youth Squad' }], [OURS]);
    expect(v.fields).toContain('event_name');
    expect(JSON.stringify(v)).not.toContain('Youth Squad');
  });

  it('survives a non-array body', () => {
    expect(summariseBookings(null).notAnArray).toBe(true);
    expect(summariseBookings('<html>').count).toBe(0);
  });
});

describe('describeBookingRequirement', () => {
  const created = { outcome: 'created' };
  const rejected = { outcome: 'rejected' };
  const failed = { outcome: 'failed' };

  it('reports no requirement when a paid event accepts a membership-less prospect', () => {
    const v = describeBookingRequirement({ paid: created });
    expect(v.requirement).toBe('none');
    expect(v.entitlementNeeded).toBe(false);
  });

  it('identifies free_class as the discriminator when paid fails and free succeeds', () => {
    const v = describeBookingRequirement({ paid: rejected, free: created });
    expect(v.requirement).toBe('free_class');
    expect(v.freeClassOnly).toBe(true);
  });

  it('reports an entitlement requirement when both are rejected — the answer that changes the tool', () => {
    const v = describeBookingRequirement({ paid: rejected, free: rejected });
    expect(v.requirement).toBe('entitlement');
    expect(v.entitlementNeeded).toBe(true);
  });

  it('will not conclude from a rejected paid event alone', () => {
    // The free comparison is what separates "cannot book at all" from "free
    // classes only", and they change #46 in very different ways.
    const v = describeBookingRequirement({ paid: rejected, free: null });
    expect(v.inconclusive).toBe(true);
    expect(v.requirement).toBeNull();
  });

  it('treats a timeout as no answer rather than as a rejection', () => {
    const v = describeBookingRequirement({ paid: failed, free: created });
    expect(v.inconclusive).toBe(true);
  });

  it('says so when nothing was attempted', () => {
    expect(describeBookingRequirement({}).summary).toMatch(/no booking was attempted/);
  });
});

describe('describeDuplicateBooking', () => {
  const created = { outcome: 'created' };

  it('reports a rejected second booking as safe', () => {
    const v = describeDuplicateBooking({ second: { outcome: 'rejected' } });
    expect(v.rejected).toBe(true);
    expect(v.idempotent).toBe(true);
    expect(v.duplicated).toBe(false);
  });

  it('catches a silent second booking by counting, not by reading the status', () => {
    // The dangerous case: HTTP 200 both times, and a student booked twice.
    const v = describeDuplicateBooking({ second: created, countBefore: 1, countAfter: 2 });
    expect(v.duplicated).toBe(true);
    expect(v.idempotent).toBe(false);
    expect(v.summary).toMatch(/double-books/);
  });

  it('reports an accepted-but-unchanged second booking as idempotent', () => {
    const v = describeDuplicateBooking({ second: created, countBefore: 1, countAfter: 1 });
    expect(v.duplicated).toBe(false);
    expect(v.idempotent).toBe(true);
  });

  it('refuses to call an uncounted success safe', () => {
    // From the response alone a silent duplicate is indistinguishable from an
    // idempotent server, so this must not resolve to `idempotent: true`.
    const v = describeDuplicateBooking({ second: created });
    expect(v.inconclusive).toBe(true);
    expect(v.idempotent).toBeNull();
  });

  it('says nothing about idempotency when the second attempt did not complete', () => {
    const v = describeDuplicateBooking({ second: { outcome: 'failed' }, countBefore: 1, countAfter: 1 });
    expect(v.inconclusive).toBe(true);
  });
});

describe('describeCancellation', () => {
  it('confirms a reversal only when the booking actually left the list', () => {
    const v = describeCancellation({ cancel: { status: 200 }, countBefore: 1, countAfter: 0 });
    expect(v.reversed).toBe(true);
  });

  it('reports a 2xx that changed nothing as a failure, not a success', () => {
    // #46 plans to rely on DELETE to undo a mistaken bulk booking, so a false
    // "reversible" is worse than no answer at all.
    const v = describeCancellation({ cancel: { status: 200 }, countBefore: 1, countAfter: 1 });
    expect(v.reversed).toBe(false);
    expect(v.summary).toMatch(/still there/);
  });

  it('reports a rejected DELETE as a booking that must be removed by hand', () => {
    const v = describeCancellation({ cancel: { status: 403 }, countBefore: 1, countAfter: 1 });
    expect(v.reversed).toBe(false);
    expect(v.summary).toMatch(/removed by hand/);
  });

  it('will not judge a cancellation nobody re-counted', () => {
    const v = describeCancellation({ cancel: { status: 200 } });
    expect(v.inconclusive).toBe(true);
    expect(v.reversed).toBeNull();
  });

  it('distinguishes a local refusal from an attempt', () => {
    expect(describeCancellation({ cancel: { refused: 'nope' } }).summary).toMatch(/refused locally/);
    expect(describeCancellation({}).summary).toMatch(/no cancellation was attempted/);
  });

  it('does not report a dry run as a rejected DELETE', () => {
    // Observed: a --cancel read-only run printed "DELETE was rejected — the
    // booking remains and must be removed by hand", inventing a failure out of
    // a request nobody sent.
    const v = describeCancellation({
      cancel: { dryRun: true, status: null },
      countBefore: 1,
      countAfter: 1,
    });
    expect(v.reversed).toBeNull();
    expect(v.inconclusive).toBe(true);
    expect(v.summary).not.toMatch(/rejected|by hand/);
  });
});

// ── staff-site#63: did the create land, and did a pass ride along? ───────────
//
// #63's standing rule is "verify each write by re-reading the resource, never
// by the status code". These two helpers are where that rule is enforced, so
// that a probe cannot report a permanent contact into existence — or out of it
// — on the strength of a number Clubworx returned.

describe('describeMemberCreation', () => {
  const found = keys => keys.map(contact_key => ({ contact_key }));

  it('calls it created when the re-read finds the contact', () => {
    const r = describeMemberCreation({ create: { status: 200 }, found: found(['ck-1']) });
    expect(r.landed).toBe(true);
    expect(r.verdict).toBe('created');
    expect(r.contactKey).toBe('ck-1');
  });

  it('calls it absent when the re-read finds nothing, even on a 200', () => {
    // The whole point of the rule. A 200 that did not create anything is the
    // failure mode the status code cannot show.
    const r = describeMemberCreation({ create: { status: 200 }, found: [] });
    expect(r.landed).toBe(false);
    expect(r.verdict).toBe('absent');
    expect(r.statusAgrees).toBe(false);
  });

  it('calls it created when the re-read finds it despite a transport error', () => {
    // ACCESS.md: a failed write may still have landed. This is the case that
    // decides whether something goes on the cleanup list.
    const r = describeMemberCreation({
      create: { status: null, error: 'ECONNRESET' },
      found: found(['ck-9']),
    });
    expect(r.landed).toBe(true);
    expect(r.verdict).toBe('created');
    expect(r.statusAgrees).toBe(false);
  });

  it('reports a refusal without claiming anything about production', () => {
    const r = describeMemberCreation({ create: { refused: 'not Ztest' }, found: [] });
    expect(r.verdict).toBe('refused');
    expect(r.landed).toBe(false);
    // Nothing was sent, so the status cannot disagree with anything.
    expect(r.statusAgrees).toBeNull();
  });

  it('flags a duplicate when the re-read finds more than one', () => {
    // Contacts cannot be deleted, so a second one is a permanent mistake that
    // has to be named rather than averaged away by taking [0].
    const r = describeMemberCreation({ create: { status: 200 }, found: found(['ck-1', 'ck-2']) });
    expect(r.verdict).toBe('duplicated');
    expect(r.landed).toBe(true);
    expect(r.duplicates).toBe(2);
  });

  it('says the status agreed when a 4xx is matched by an absent contact', () => {
    const r = describeMemberCreation({ create: { status: 422 }, found: [] });
    expect(r.verdict).toBe('absent');
    expect(r.statusAgrees).toBe(true);
  });

  it('treats a missing re-read as unknown rather than as absent', () => {
    // "We did not look" and "we looked and it was not there" must not collapse:
    // one of them puts a permanent record on the cleanup list and the other
    // does not.
    const r = describeMemberCreation({ create: { status: 200 }, found: null });
    expect(r.verdict).toBe('unverified');
    expect(r.landed).toBeNull();
  });
});

describe('describeCreatedPass', () => {
  const on = '2026-08-20';

  it('reports no pass when the plan states are empty', () => {
    const r = describeCreatedPass({ states: [], on });
    expect(r.granted).toBe(false);
    expect(r.active).toBe(false);
  });

  it('reports the dates of a pass that was granted', () => {
    const r = describeCreatedPass({
      states: [{ start_date: '2026-08-20', expiration_date: '2026-11-12', active: true }],
      on,
    });
    expect(r.granted).toBe(true);
    expect(r.active).toBe(true);
    expect(r.startDate).toBe('2026-08-20');
    expect(r.expirationDate).toBe('2026-11-12');
  });

  it('measures the span in days, so a 12-week plan can be recognised', () => {
    const r = describeCreatedPass({
      states: [{ start_date: '2026-08-20', expiration_date: '2026-11-12', active: true }],
      on,
    });
    expect(r.spanDays).toBe(84);
  });

  it('says whether the pass started on the day it was created — question 4', () => {
    // `POST /members` takes no start_date. Whether Clubworx defaults it to
    // today is the whole trade-off in adopting the one-call route.
    const same = describeCreatedPass({
      states: [{ start_date: '2026-08-20', expiration_date: '2026-11-12', active: true }],
      on,
    });
    const not = describeCreatedPass({
      states: [{ start_date: '2026-08-01', expiration_date: '2026-10-24', active: true }],
      on,
    });
    expect(same.startsOnCreationDay).toBe(true);
    expect(not.startsOnCreationDay).toBe(false);
  });

  it('says whether the start date matched one that was asked for', () => {
    const r = describeCreatedPass({
      states: [{ start_date: '2026-08-25', expiration_date: '2026-11-17', active: true }],
      on,
      requested: '2026-08-25',
    });
    expect(r.honouredRequest).toBe(true);
  });

  it('leaves honouredRequest null when nothing was asked for', () => {
    // The one-call route sends no start_date at all, so there is no request to
    // have been honoured or ignored.
    const r = describeCreatedPass({
      states: [{ start_date: '2026-08-20', expiration_date: '2026-11-12', active: true }],
      on,
    });
    expect(r.honouredRequest).toBeNull();
  });

  it('prefers the active pass when a contact holds more than one', () => {
    const r = describeCreatedPass({
      states: [
        { start_date: '2026-01-01', expiration_date: '2026-03-26', active: false },
        { start_date: '2026-08-20', expiration_date: '2026-11-12', active: true },
      ],
      on,
    });
    expect(r.startDate).toBe('2026-08-20');
    expect(r.held).toBe(2);
  });

  it('survives a pass with no dates rather than computing a span from null', () => {
    const r = describeCreatedPass({ states: [{ start_date: null, expiration_date: null }], on });
    expect(r.granted).toBe(true);
    expect(r.spanDays).toBeNull();
    expect(r.startsOnCreationDay).toBe(false);
  });
});

describe('describeEventById', () => {
  const wantedId = 12345;
  const ok = body => ({ status: 200, body, error: null });

  const row = (event_id = wantedId) => ({
    event_id,
    event_name: 'a class',
    event_start_at: '2026-09-01T10:00:00+08:00',
    spaces_available: 4,
  });

  it('reads a bare object carrying the asked-for id as a resolving route', () => {
    const out = describeEventById({ wantedId, direct: ok(row()) });

    expect(out.verdict).toBe('single-object');
    expect(out.isRoute).toBe(true);
    expect(out.resolvesFallback).toBe(true);
  });

  it('reads a corroborated one-element array as a resolving route', () => {
    const out = describeEventById({
      wantedId,
      direct: ok([row()]),
      // The window held more than the one row that came back, so the path
      // segment narrowed it — the collection cannot be what answered.
      collectionIds: [wantedId, 999, 1000],
    });

    expect(out.verdict).toBe('one-element-array');
    expect(out.isRoute).toBe(true);
    expect(out.confounded).toBe(false);
    expect(out.resolvesFallback).toBe(true);
  });

  it('will not call an uncorroborated one-element array a route', () => {
    // A window holding exactly one event answers a path-ignoring collection
    // read and a genuine resolution identically. Nothing here can tell them
    // apart, so nothing here may claim to.
    const out = describeEventById({ wantedId, direct: ok([row()]) });

    expect(out.verdict).toBe('one-element-array');
    expect(out.confounded).toBeNull();
    expect(out.isRoute).toBeNull();
  });

  it('takes a bare object as evidence in itself — the collection never sends one', () => {
    const out = describeEventById({ wantedId, direct: ok(row()) });

    expect(out.confounded).toBe(false);
    expect(out.isRoute).toBe(true);
  });

  it('refuses to call it a route when a made-up id answers the same way', () => {
    const out = describeEventById({
      wantedId,
      missingId: 999999999,
      direct: ok([row()]),
      collectionIds: [wantedId, 999, 1000],
      missing: ok([row(999999999)]),
    });

    expect(out.confounded).toBe(true);
    expect(out.isRoute).toBe(false);
  });

  it('refuses to call it a route when the rows returned are the whole collection', () => {
    const out = describeEventById({
      wantedId,
      direct: ok([row()]),
      collectionIds: [wantedId],
    });

    expect(out.echoesCollection).toBe(true);
    expect(out.confounded).toBe(true);
    expect(out.isRoute).toBe(false);
  });

  it('reads a 2xx body it cannot interpret as unmeasured, not as an absent route', () => {
    // A single event naming its key `id` rather than `event_id` would land
    // here. That is a shape nobody has read yet, not a missing route.
    const out = describeEventById({ wantedId, direct: ok({ id: wantedId, name: 'x' }) });

    expect(out.verdict).toBe('unrecognised');
    expect(out.isRoute).toBeNull();
    expect(out.resolvesFallback).toBe(false);
  });

  it('matches the id as text, because a pasted id is a string and Clubworx sends a number', () => {
    const out = describeEventById({ wantedId: '12345', direct: ok(row(12345)) });

    expect(out.verdict).toBe('single-object');
    expect(out.resolvesFallback).toBe(true);
  });

  it('calls a multi-row answer the collection, not a resolution', () => {
    const out = describeEventById({ wantedId, direct: ok([row(), row(999)]) });

    expect(out.verdict).toBe('collection');
    expect(out.isRoute).toBe(false);
    expect(out.resolvesFallback).toBe(false);
  });

  it('calls a single row that is not the asked-for event the collection', () => {
    // The path segment was ignored and the gym happened to have one event in
    // the window. Taking row one would put the wrong class in front of staff.
    const out = describeEventById({ wantedId, direct: ok([row(999)]) });

    expect(out.verdict).toBe('collection');
    expect(out.resolvesFallback).toBe(false);
  });

  it('names the collection when the ids returned are the ids the listing held', () => {
    const out = describeEventById({
      wantedId,
      direct: ok([row(), row(999)]),
      collectionIds: [wantedId, 999],
    });

    expect(out.verdict).toBe('collection');
    expect(out.echoesCollection).toBe(true);
  });

  it('reports an empty array as a filter that matched nothing, not as a route', () => {
    const out = describeEventById({ wantedId, direct: ok([]) });

    expect(out.verdict).toBe('empty');
    expect(out.isRoute).toBe(false);
    expect(out.resolvesFallback).toBe(false);
  });

  it('reads a 404 on a real id as no such route', () => {
    const out = describeEventById({ wantedId, direct: { status: 404, body: null, error: null } });

    expect(out.verdict).toBe('not-found');
    expect(out.isRoute).toBe(false);
  });

  it('refuses to conclude anything from a 401 — #50 is what that costs', () => {
    const out = describeEventById({ wantedId, direct: { status: 401, body: null, error: null } });

    expect(out.verdict).toBe('refused');
    expect(out.isRoute).toBeNull();
    expect(out.resolvesFallback).toBe(false);
    expect(out.summary).toMatch(/parameters/i);
  });

  it('reports a network failure as unmeasured rather than as an absent route', () => {
    const out = describeEventById({
      wantedId,
      direct: { status: null, body: null, error: 'ECONNRESET' },
    });

    expect(out.verdict).toBe('error');
    expect(out.isRoute).toBeNull();
  });

  it('records field names, never values', () => {
    const out = describeEventById({ wantedId, direct: ok(row()) });

    expect(out.fields).toEqual(['event_id', 'event_name', 'event_start_at', 'spaces_available']);
    expect(JSON.stringify(out)).not.toContain('a class');
  });

  it('counts the row a bare object carries — one row, not none', () => {
    const out = describeEventById({ wantedId, direct: ok(row()) });

    expect(out.returnedIds).toEqual([wantedId]);
  });

  it('describes what a made-up id answered', () => {
    const out = describeEventById({
      wantedId,
      direct: ok(row()),
      missing: { status: 404, body: null, error: null },
    });

    expect(out.missingBehaviour).toBe('not-found');
    expect(out.discriminates).toBe(true);
  });

  it('flags a made-up id that answers with rows anyway — the route would confirm any paste', () => {
    const out = describeEventById({
      wantedId,
      direct: ok(row()),
      missing: ok([row(999), row(1000)]),
    });

    expect(out.missingBehaviour).toBe('collection');
    expect(out.discriminates).toBe(false);
  });

  it('flags a made-up id that resolves as an event — read against the id actually asked for', () => {
    // The made-up call asked for `missingId`, not `wantedId`. Reading it
    // against the real id would score a resolved fake as "unrecognised" and
    // report the route as discriminating on precisely the case that proves it
    // does not.
    const out = describeEventById({
      wantedId,
      missingId: 999999999,
      direct: ok(row()),
      missing: ok(row(999999999)),
    });

    expect(out.missingBehaviour).toBe('single-object');
    expect(out.discriminates).toBe(false);
  });

  it('leaves the made-up id unknown when the answer was a refusal, not an absence', () => {
    const out = describeEventById({
      wantedId,
      missingId: 999999999,
      direct: ok(row()),
      missing: { status: 401, body: null, error: null },
    });

    expect(out.missingBehaviour).toBe('refused');
    expect(out.discriminates).toBeNull();
  });

  it('counts an empty answer to a made-up id as discriminating', () => {
    const out = describeEventById({
      wantedId,
      missingId: 999999999,
      direct: ok(row()),
      missing: ok([]),
    });

    expect(out.discriminates).toBe(true);
  });

  it('leaves the made-up id unknown when that call was not made', () => {
    const out = describeEventById({ wantedId, direct: ok(row()) });

    expect(out.missingBehaviour).toBeNull();
    expect(out.discriminates).toBeNull();
  });

  it('answers for the shipped route from the windowless call, because that is what it sends', () => {
    // `resolveEvent` calls `client.get('events/<id>')` with no params at all.
    // A route that resolves only *with* a window is a route the shipped code
    // does not have — reporting the windowed 200 as success would green-light
    // a production failure.
    const out = describeEventById({
      wantedId,
      direct: ok(row()),
      windowless: { status: 422, body: null, error: null },
    });

    expect(out.verdict).toBe('single-object');
    expect(out.isRoute).toBe(true);
    expect(out.resolvesFallback).toBe(false);
    expect(out.fallbackBasis).toBe('windowless');
  });

  it('falls back to the windowed call when the windowless one was not made, and says so', () => {
    const out = describeEventById({ wantedId, direct: ok(row()) });

    expect(out.resolvesFallback).toBe(true);
    expect(out.fallbackBasis).toBe('windowed');
  });

  it('reports the date window as not required when the windowless call resolves', () => {
    const out = describeEventById({ wantedId, direct: ok(row()), windowless: ok(row()) });

    expect(out.windowRequired).toBe(false);
  });

  it('reports the date window as required when the windowless call is refused', () => {
    const out = describeEventById({
      wantedId,
      direct: ok(row()),
      windowless: { status: 422, body: null, error: null },
    });

    expect(out.windowRequired).toBe(true);
  });

  it('leaves the window question open when that call was not made', () => {
    const out = describeEventById({ wantedId, direct: ok(row()) });

    expect(out.windowRequired).toBeNull();
  });
});
