import { describe, it, expect } from 'vitest';
import { MAX_PAGES, PAGE_SIZE, findPlanByName, lookupPlan } from '../src/plans.js';

// The plan lookup, and the two ways it stops a run dead.
//
// **The list truncates silently.** `GET /membership_plans` returned exactly 50 —
// the default `page_size` — on 2026-08-18, and UJ has 57 plans. School Pass was
// among the seven that never arrived (#60). Every test below that counts pages
// or checks `page_size` is guarding that: "no such plan" read off a full page is
// not an answer, it is a truncation nobody noticed.
//
// **A duplicate name would be ambiguous**, and assigning the wrong plan is a
// permanent mark on a real person. So two matches is a refusal, never a
// first-wins.
//
// The third theme is `membership_duration`. It is a human string typed into a
// plan editor, and it is what the write chain's pre-write coverage check runs on
// (§11, ADR 0005). It travels **verbatim** as well as parsed, because a value
// this cannot parse has to be reportable on screen with its raw text rather than
// silently dropped.

const plan = (over = {}) => ({
  id: 'mp-school',
  name: 'School Pass',
  membership_duration: '26 weeks',
  ...over,
});

/** Filler rows, so a page can be made exactly full without naming 200 plans. */
const filler = n => Array.from({ length: n }, (_, i) => plan({ id: `mp-${i}`, name: `Plan ${i}` }));

/**
 * A Clubworx client stub: one canned page per page number, plus a call recorder.
 *
 * Keyed by page so the paging walk is asserted directly — the walk is the whole
 * point of this module, and a stub that answers the same body forever would let
 * a broken one pass.
 */
function clientWith(pages, over = {}) {
  const calls = [];
  return {
    calls,
    get: async (path, params) => {
      calls.push({ path, params });
      const body = pages[params.page] ?? [];
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

describe('findPlanByName', () => {
  it('resolves an exact name, case-insensitively and ignoring surrounding space', () => {
    const found = findPlanByName([plan({ name: '  school pass ' })], 'School Pass');
    expect(found.plan.id).toBe('mp-school');
    expect(found.matches).toBe(1);
    expect(found.ambiguous).toBe(false);
  });

  it('refuses two plans sharing a name rather than taking the first', () => {
    const found = findPlanByName([plan({ id: 'a' }), plan({ id: 'b' })], 'School Pass');
    expect(found.plan).toBe(null);
    expect(found.matches).toBe(2);
    expect(found.ambiguous).toBe(true);
  });

  it('flags a page that came back exactly full as truncated', () => {
    const found = findPlanByName(filler(50), 'School Pass', { requestedPageSize: 50 });
    expect(found.plan).toBe(null);
    expect(found.truncated).toBe(true);
  });

  it('does not flag a short page', () => {
    const found = findPlanByName(filler(3), 'School Pass', { requestedPageSize: 50 });
    expect(found.truncated).toBe(false);
  });

  it('reports a body that is not a list rather than reading it as no plans', () => {
    const found = findPlanByName({ error: 'nope' }, 'School Pass');
    expect(found.notAnArray).toBe(true);
    expect(found.plan).toBe(null);
  });
});

describe('lookupPlan', () => {
  it('asks for a page size past the default, because the default is the trap', async () => {
    const client = clientWith({ 1: [plan()] });
    await lookupPlan({ client, name: 'School Pass' });

    expect(client.calls[0].path).toBe('membership_plans');
    expect(client.calls[0].params.page_size).toBe(PAGE_SIZE);
    expect(PAGE_SIZE).toBeGreaterThan(50);
  });

  it('returns the id, the name and the raw duration', async () => {
    const client = clientWith({ 1: [plan()] });
    const result = await lookupPlan({ client, name: 'School Pass' });

    expect(result.ok).toBe(true);
    // Clubworx calls it `id` on the plan and `membership_plan_id` on the write.
    // The route hands over the name the write chain uses.
    expect(result.plan.membership_plan_id).toBe('mp-school');
    expect(result.plan.name).toBe('School Pass');
    expect(result.plan.membership_duration).toBe('26 weeks');
  });

  it('parses the duration and keeps the raw string beside it', async () => {
    const client = clientWith({ 1: [plan()] });
    const result = await lookupPlan({ client, name: 'School Pass' });

    expect(result.plan.duration).toEqual({ ok: true, count: 26, unit: 'week', raw: '26 weeks' });
  });

  it('resolves a plan whose duration will not parse, and reports the raw value', async () => {
    // Never a silent drop and never a refusal: §11 warns on screen naming the
    // raw value, because the alternative is a coverage check skipped in silence.
    const client = clientWith({ 1: [plan({ membership_duration: 'one school term' })] });
    const result = await lookupPlan({ client, name: 'School Pass' });

    expect(result.ok).toBe(true);
    expect(result.plan.membership_duration).toBe('one school term');
    expect(result.plan.duration.ok).toBe(false);
    expect(result.plan.duration.raw).toBe('one school term');
  });

  it('pages past a full first page, and finds a plan the default page would have hidden', async () => {
    // The measured failure, in miniature: School Pass is not on page 1.
    const client = clientWith({ 1: filler(PAGE_SIZE), 2: [plan()] });
    const result = await lookupPlan({ client, name: 'School Pass' });

    expect(result.ok).toBe(true);
    expect(result.plan.membership_plan_id).toBe('mp-school');
    expect(result.pages).toBe(2);
    expect(client.calls.map(c => c.params.page)).toEqual([1, 2]);
  });

  it('stops on a short page — the only end-of-list signal Clubworx offers', async () => {
    const client = clientWith({ 1: filler(3) });
    await lookupPlan({ client, name: 'School Pass' });
    expect(client.calls).toHaveLength(1);
  });

  it('refuses a name with no match rather than answering with nothing', async () => {
    const client = clientWith({ 1: filler(3) });
    const result = await lookupPlan({ client, name: 'School Pass' });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('plan-not-found');
    expect(result.message).toContain('School Pass');
  });

  it('refuses a duplicate name, naming how many matched', async () => {
    const client = clientWith({ 1: [plan({ id: 'a' }), plan({ id: 'b' })] });
    const result = await lookupPlan({ client, name: 'School Pass' });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('plan-ambiguous');
    expect(result.matches).toBe(2);
  });

  it('reports truncation rather than "not found" when the walk hit its ceiling still full', async () => {
    const everyPageFull = Object.fromEntries(
      Array.from({ length: MAX_PAGES }, (_, i) => [i + 1, filler(PAGE_SIZE)]),
    );
    const client = clientWith(everyPageFull);
    const result = await lookupPlan({ client, name: 'School Pass' });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('plan-list-truncated');
    expect(client.calls).toHaveLength(MAX_PAGES);
  });

  it('tells a throttle apart from every other upstream failure', async () => {
    const client = clientWith({ 1: [] }, { ok: false, status: 429, body: null, bodyText: 'slow down' });
    const result = await lookupPlan({ client, name: 'School Pass' });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('throttled');
    expect(result.upstreamStatus).toBe(429);
  });

  it('reports any other upstream failure as itself', async () => {
    const client = clientWith({ 1: [] }, { ok: false, status: 500, body: null, message: 'boom' });
    const result = await lookupPlan({ client, name: 'School Pass' });

    expect(result.reason).toBe('upstream-error');
    expect(result.message).toBe('boom');
    expect(result.upstreamStatus).toBe(500);
  });

  it('refuses a 200 whose body is not a list of plans', async () => {
    const client = clientWith({}, { body: { plans: [] } });
    const result = await lookupPlan({ client, name: 'School Pass' });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('upstream-error');
  });

  it('refuses a matched plan that carries no id, because it cannot be written', async () => {
    const client = clientWith({ 1: [plan({ id: null })] });
    const result = await lookupPlan({ client, name: 'School Pass' });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('upstream-error');
    expect(result.message).toContain('id');
  });

  it('refuses an empty name without calling Clubworx', async () => {
    const client = clientWith({ 1: [plan()] });
    const result = await lookupPlan({ client, name: '   ' });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('bad-request');
    expect(client.calls).toHaveLength(0);
  });

  it('counts every request it made, on the way out and on the way to a refusal', async () => {
    const client = clientWith({ 1: filler(PAGE_SIZE), 2: [plan()] });
    const result = await lookupPlan({ client, name: 'School Pass' });
    expect(result.requests).toBe(2);
  });
});

describe('lookupPlan — the coverage end (staff-site#72)', () => {
  it('says when a pass granted today runs out, so the page never re-derives it', () => {
    // The page has to hard-stop a run whose last session falls outside the
    // pass (§11, ADR 0005), and the calendar arithmetic that answers that lives
    // here, tested, beside `parsePlanDuration`. A second copy in the browser is
    // the drift that decides a run is safe when it is not.
    const client = clientWith({ 1: [plan()] });
    return lookupPlan({ client, name: 'School Pass', today: '2026-08-21' }).then(result => {
      // 26 weeks = 182 days, inclusive at both ends: 21 Aug + 181 days.
      expect(result.plan.coverage_end).toBe('2027-02-18');
    });
  });

  it('leaves the coverage end null when the duration will not parse', async () => {
    // Never a plausible-looking date. Null is what makes the page warn out
    // loud instead of checking a number nobody computed.
    const client = clientWith({ 1: [plan({ membership_duration: 'one school term' })] });
    const result = await lookupPlan({ client, name: 'School Pass', today: '2026-08-21' });

    expect(result.plan.coverage_end).toBe(null);
    expect(result.plan.duration.ok).toBe(false);
  });

  it('defaults the run day to the Perth day, not the UTC one', async () => {
    // 23:30 UTC on the 21st is 07:30 on the 22nd in Perth. Counting a pass
    // from the wrong day shortens or lengthens its coverage by one, which is
    // exactly the size of the last-session edge case this check exists for.
    const client = clientWith({ 1: [plan()] });
    const result = await lookupPlan({ client, name: 'School Pass', now: new Date('2026-08-21T23:30:00Z') });

    expect(result.plan.coverage_end).toBe('2027-02-19');
  });
});
