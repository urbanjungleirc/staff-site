import { describe, it, expect } from 'vitest';
import { runStudentChain } from '../src/student.js';
import { ALREADY_BOOKED, CLASS_CLOSED, NO_FREE_SPACES } from '../src/bookings.js';

const PLAN = 64189;
const NOW = '2026-08-20T02:00:00Z'; // 10:00 in Perth, on the 20th.
const TODAY = '2026-08-20';

const STUDENT = {
  first_name: 'Ada',
  last_name: 'Wayfinder',
  dob: '2012-03-04',
  email: 'noreply+stbedes@urbanjungleirc.com',
};

/** Two sessions, both comfortably outside the 24-hour lead time. */
const EVENTS = [
  { event_id: 101, starts_at: '2026-09-03T02:00:00Z' },
  { event_id: 102, starts_at: '2026-09-10T02:00:00Z' },
];

const res = over => ({
  ok: false,
  status: 400,
  url: 'https://app.clubworx.com/api/v2/x',
  ms: 1,
  body: null,
  nonJson: false,
  bodyText: null,
  message: null,
  networkError: false,
  ...over,
});
const ok = body => res({ ok: true, status: 200, body });
const refused = message => res({ status: 400, body: { error: message }, message });

const pass = (start, expires) => ({
  membership_plan_id: PLAN,
  start_date: start,
  expiration_date: expires,
});

/** A contact row as the three status views return it. */
const contactRow = () => ({ ...STUDENT, contact_key: 'ck-new', status: 'Active' });

/**
 * A client whose responses are chosen by a dispatcher over `${method} ${path}`.
 * `nth` is 1-based per route, so a re-read can differ from the read before it.
 */
function makeClient(routes) {
  const calls = [];
  const counts = new Map();

  const handle = async call => {
    calls.push(call);
    const key = `${call.method} ${call.path.replace(/\/[^/]+$/, m => (call.path.startsWith('bookings/') ? '/:id' : m))}`;
    const route =
      routes[key] ??
      routes[`${call.method} ${call.path}`] ??
      routes[call.method === 'DELETE' ? 'DELETE bookings/:id' : ''];
    if (!route) throw new Error(`no scripted response for ${call.method} ${call.path}`);
    const nth = (counts.get(key) ?? 0) + 1;
    counts.set(key, nth);
    return typeof route === 'function' ? route(nth, call) : route;
  };

  return {
    calls,
    get: (path, params) => handle({ method: 'GET', path, params }),
    post: (path, payload) => handle({ method: 'POST', path, payload }),
    postForm: (path, form) => handle({ method: 'POSTFORM', path, form }),
    del: (path, form) => handle({ method: 'DELETE', path, form }),
  };
}

const run = (client, over = {}) =>
  runStudentChain({
    client,
    student: STUDENT,
    contactKey: null,
    membershipPlanId: PLAN,
    membershipDuration: '26 weeks',
    events: EVENTS,
    now: NOW,
    sleep: async () => {},
    ...over,
  });

// ---------------------------------------------------------------------------
// Gates that must fire before anything permanent is written
// ---------------------------------------------------------------------------

describe('refusals before any permanent write', () => {
  it('stops on an event inside the 24-hour lead time, and touches nothing', async () => {
    const client = makeClient({});
    const out = await run(client, {
      events: [{ event_id: 101, starts_at: '2026-08-20T12:00:00Z' }],
    });

    expect(out).toMatchObject({ ok: false, outcome: 'refused', reason: 'lead-time', written: false });
    expect(client.calls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // ADR 0007 — the lead time is an operator override, not a law. The gate is
  // NARROWED to sessions nobody acknowledged; it is never switched off. Every
  // test below has to stay able to tell those two apart.
  // -------------------------------------------------------------------------

  it('books a too-soon session the operator acknowledged', async () => {
    const client = makeClient({
      'POST members': ok({ contact_key: 'ck-new' }),
      'GET members': ok([contactRow()]),
      'POST bookings': ok({ booking_id: 'b1' }),
      'GET bookings': ok([{ booking_id: 'b1', event_id: 101 }]),
    });
    const out = await run(client, {
      events: [{ event_id: 101, starts_at: '2026-08-20T12:00:00Z' }],
      leadTimeAcknowledgedEventIds: [101],
    });

    expect(out.outcome).toBe('complete');
  });

  it('names only the unacknowledged session when two are too soon and one is acknowledged', async () => {
    // The whole point of ids over a flag: acknowledging Tuesday must not
    // acknowledge Thursday.
    const client = makeClient({});
    const out = await run(client, {
      events: [
        { event_id: 101, starts_at: '2026-08-20T12:00:00Z' },
        { event_id: 102, starts_at: '2026-08-20T14:00:00Z' },
      ],
      leadTimeAcknowledgedEventIds: [101],
    });

    expect(out).toMatchObject({ outcome: 'refused', reason: 'lead-time', written: false });
    expect(out.leadTimeEventIds).toEqual([102]);
    expect(out.message).toContain('1 selected session(s)');
    expect(client.calls).toHaveLength(0);
  });

  it('ignores an acknowledgement naming a session this run did not select', async () => {
    const client = makeClient({});
    const out = await run(client, {
      events: [{ event_id: 101, starts_at: '2026-08-20T12:00:00Z' }],
      leadTimeAcknowledgedEventIds: [999],
    });

    expect(out).toMatchObject({ outcome: 'refused', reason: 'lead-time' });
    expect(out.leadTimeEventIds).toEqual([101]);
  });

  it('matches an acknowledged id whatever it was carried as, so a string id from JSON still counts', async () => {
    const client = makeClient({
      'POST members': ok({ contact_key: 'ck-new' }),
      'GET members': ok([contactRow()]),
      'POST bookings': ok({ booking_id: 'b1' }),
      'GET bookings': ok([{ booking_id: 'b1', event_id: 101 }]),
    });
    const out = await run(client, {
      events: [{ event_id: 101, starts_at: '2026-08-20T12:00:00Z' }],
      leadTimeAcknowledgedEventIds: ['101'],
    });

    expect(out.outcome).toBe('complete');
  });

  it('still refuses a session that has already started, acknowledged or not', async () => {
    // ADR 0007: only the lead-time refusal is overridable. An already-started
    // session is not a restriction the gym can lift, so no confirmation can
    // buy it. The Worker has no separate past-session gate — a started session
    // reaches the lead-time filter as a NEGATIVE delta — so the narrowing has
    // to exclude it explicitly or acknowledging one books it.
    const client = makeClient({});
    const out = await run(client, {
      events: [{ event_id: 101, starts_at: '2026-08-19T02:00:00Z' }], // a day ago
      leadTimeAcknowledgedEventIds: [101],
    });

    expect(out).toMatchObject({ outcome: 'refused', reason: 'lead-time', written: false });
    expect(out.leadTimeEventIds).toEqual([101]);
    expect(client.calls).toHaveLength(0);
  });

  it('treats a session starting exactly now as started, not as overridable', async () => {
    // The boundary belongs on the refusing side: at the instant it starts there
    // is nothing left to book.
    const client = makeClient({});
    const out = await run(client, {
      events: [{ event_id: 101, starts_at: NOW }],
      leadTimeAcknowledgedEventIds: [101],
    });

    expect(out).toMatchObject({ outcome: 'refused', reason: 'lead-time' });
    expect(out.leadTimeEventIds).toEqual([101]);
  });

  it('still refuses a session whose start cannot be read, acknowledged or not', async () => {
    // "We cannot check this" must never become "you may override this".
    const client = makeClient({});
    const out = await run(client, {
      events: [{ event_id: 101, starts_at: 'not a date' }],
      leadTimeAcknowledgedEventIds: [101],
    });

    expect(out).toMatchObject({ outcome: 'refused', reason: 'bad-request', written: false });
    expect(client.calls).toHaveLength(0);
  });

  it('refuses an unacknowledged too-soon session exactly as before when acknowledgements are absent', async () => {
    // The no-acknowledgement path is today's path, and it must not have moved.
    const client = makeClient({});
    const events = [{ event_id: 101, starts_at: '2026-08-20T12:00:00Z' }];
    const before = await run(client, { events });
    const after = await run(client, { events, leadTimeAcknowledgedEventIds: [] });

    expect(after).toEqual(before);
    expect(before.leadTimeEventIds).toEqual([101]);
    expect(client.calls).toHaveLength(0);
  });

  it('stops when the last session falls outside the plan duration', async () => {
    // A 26-week pass granted 2026-08-20 covers to 2027-02-17. A session in March
    // is past that, and every booking would still be written on a day the pass
    // is active — the exact shape of the bug ADR 0005 fixed.
    const client = makeClient({});
    const out = await run(client, {
      events: [{ event_id: 101, starts_at: '2027-03-01T02:00:00Z' }],
    });

    expect(out).toMatchObject({ ok: false, outcome: 'refused', reason: 'pass-coverage' });
    expect(out.message).toContain('2027-02-17');
    expect(client.calls).toHaveLength(0);
  });

  it('allows a last session landing exactly on the coverage end', async () => {
    const client = makeClient({
      'POST members': ok({ contact_key: 'ck-new' }),
      'GET members': ok([contactRow()]),
      'POST bookings': ok({ booking_id: 'b1' }),
      'GET bookings': ok([{ booking_id: 'b1', event_id: 101 }]),
    });
    const out = await run(client, {
      events: [{ event_id: 101, starts_at: '2027-02-17T02:00:00Z' }],
    });

    expect(out.outcome).toBe('complete');
  });

  it('warns rather than stopping when membership_duration will not parse — and names it', async () => {
    const client = makeClient({
      'POST members': ok({ contact_key: 'ck-new' }),
      'GET members': ok([contactRow()]),
      'POST bookings': ok({ booking_id: 'b1' }),
      'GET bookings': ok([
        { booking_id: 'b1', event_id: 101 },
        { booking_id: 'b2', event_id: 102 },
      ]),
    });
    const out = await run(client, { membershipDuration: 'a term' });

    expect(out.outcome).toBe('complete');
    expect(out.warnings.join(' ')).toContain('a term');
    // Never skipped silently — §11.
    expect(out.warnings.join(' ').toLowerCase()).toContain('coverage');
  });

  it('stops on no events at all', async () => {
    const client = makeClient({});
    const out = await run(client, { events: [] });
    expect(out).toMatchObject({ outcome: 'refused', reason: 'bad-request' });
    expect(client.calls).toHaveLength(0);
  });

  it('stops on an event whose start it cannot read, rather than assuming it is far off', async () => {
    const client = makeClient({});
    const out = await run(client, { events: [{ event_id: 101, starts_at: 'sometime' }] });
    expect(out.outcome).toBe('refused');
    expect(client.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The new-student branch: one call creates the contact and the pass
// ---------------------------------------------------------------------------

describe('a new student', () => {
  const happy = () =>
    makeClient({
      'POST members': ok({ contact_key: 'ck-new' }),
      'GET members': ok([contactRow()]),
      'POST bookings': nth => ok({ booking_id: `b${nth}` }),
      'GET bookings': ok([
        { booking_id: 'b1', event_id: 101 },
        { booking_id: 'b2', event_id: 102 },
      ]),
    });

  it('creates the contact and the pass in one JSON call', async () => {
    const client = happy();
    await run(client);

    const create = client.calls.find(c => c.method === 'POST' && c.path === 'members');
    expect(create.payload).toMatchObject({ ...STUDENT, membership_plan_id: PLAN });
  });

  it('sends only the four fields Clubworx asked for, never the caller object', async () => {
    // The body arrives over HTTP from a page this Worker does not control, and
    // an extra key would be written onto a contact nobody can delete — silently,
    // since Clubworx answers 200 either way.
    const client = happy();
    await run(client, {
      student: { ...STUDENT, notes: 'allergic to peanuts', admin_flag: true, id: 'injected' },
    });

    const create = client.calls.find(c => c.method === 'POST' && c.path === 'members');
    expect(Object.keys(create.payload).sort()).toEqual(
      ['dob', 'email', 'first_name', 'last_name', 'membership_plan_id'].sort(),
    );
  });

  it('takes membership_plan_id from the resolved plan, not from the student object', async () => {
    const client = happy();
    await run(client, { student: { ...STUDENT, membership_plan_id: 999 }, membershipPlanId: PLAN });

    const create = client.calls.find(c => c.method === 'POST' && c.path === 'members');
    expect(create.payload.membership_plan_id).toBe(PLAN);
  });

  it('never reads memberships for a contact it just created — D4', async () => {
    const client = happy();
    await run(client);
    expect(client.calls.some(c => c.path === 'memberships')).toBe(false);
  });

  it('takes the contact key from the re-read, not from the create response', async () => {
    const client = makeClient({
      // A create response with no key at all, which #49 had to tolerate.
      'POST members': ok({ success: true }),
      'GET members': ok([{ ...contactRow(), contact_key: 'ck-from-read' }]),
      'POST bookings': nth => ok({ booking_id: `b${nth}` }),
      'GET bookings': ok([
        { booking_id: 'b1', event_id: 101 },
        { booking_id: 'b2', event_id: 102 },
      ]),
    });
    const out = await run(client);

    expect(out.contact).toMatchObject({ contact_key: 'ck-from-read', state: 'created' });
  });

  it('books every event and reports the run complete', async () => {
    const out = await run(happy());
    expect(out).toMatchObject({ ok: true, outcome: 'complete', stranded: false });
    expect(out.bookings.map(b => b.state)).toEqual(['booked', 'booked']);
    expect(out.pass.state).toBe('created-with-contact');
  });

  it('reports the create as unverified when the re-read cannot find the contact', async () => {
    // A 200 that did not land is indistinguishable from one that did by the
    // status alone. The re-read is the verdict.
    const client = makeClient({
      'POST members': ok({ contact_key: 'ck-new' }),
      'GET members': ok([]),
    });
    const out = await run(client);

    expect(out).toMatchObject({ ok: false, outcome: 'failed', reason: 'contact-unverified' });
    expect(client.calls.some(c => c.path === 'bookings')).toBe(false);
  });

  it('continues when the create errored but the re-read proves it landed', async () => {
    // The dangerous retry: a connection failure on a write that cannot be
    // deleted. Re-reading before retrying is what stops a second permanent
    // contact.
    const client = makeClient({
      'POST members': res({ status: 0, networkError: true, message: 'ECONNRESET' }),
      'GET members': ok([contactRow()]),
      'POST bookings': nth => ok({ booking_id: `b${nth}` }),
      'GET bookings': ok([
        { booking_id: 'b1', event_id: 101 },
        { booking_id: 'b2', event_id: 102 },
      ]),
    });
    const out = await run(client);

    expect(out.outcome).toBe('complete');
    expect(client.calls.filter(c => c.method === 'POST' && c.path === 'members')).toHaveLength(1);
  });

  it('retries a create only after a re-read shows it did not land', async () => {
    const client = makeClient({
      'POST members': nth => (nth === 1 ? res({ status: 503 }) : ok({ contact_key: 'ck-new' })),
      'GET members': nth => (nth === 1 ? ok([]) : ok([contactRow()])),
      'POST bookings': nth => ok({ booking_id: `b${nth}` }),
      'GET bookings': ok([
        { booking_id: 'b1', event_id: 101 },
        { booking_id: 'b2', event_id: 102 },
      ]),
    });
    const out = await run(client);

    expect(out.outcome).toBe('complete');
    expect(client.calls.filter(c => c.method === 'POST' && c.path === 'members')).toHaveLength(2);
  });

  it('refuses when two contacts match what it just created', async () => {
    // Either the dedup read missed one, or this run has just made a duplicate.
    // Both need a human, and neither may be booked past.
    const client = makeClient({
      'POST members': ok({ contact_key: 'ck-new' }),
      'GET members': ok([contactRow(), { ...contactRow(), contact_key: 'ck-other' }]),
    });
    const out = await run(client);

    expect(out).toMatchObject({ ok: false, reason: 'contact-ambiguous' });
    expect(client.calls.some(c => c.path === 'bookings')).toBe(false);
  });

  it('never retries a 400 on the create', async () => {
    const client = makeClient({
      'POST members': refused('email is invalid'),
      'GET members': ok([]),
    });
    await run(client);

    expect(client.calls.filter(c => c.method === 'POST' && c.path === 'members')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The matched-student branch: D14's re-read, then D4's verdict
// ---------------------------------------------------------------------------

describe('a matched student', () => {
  const matched = { contactKey: 'ck-known' };

  it('re-reads the membership immediately before the write it guards — D14', async () => {
    const client = makeClient({
      'GET memberships': ok([pass('2026-08-01', '2027-01-28')]),
      'POST bookings': nth => ok({ booking_id: `b${nth}` }),
      'GET bookings': ok([
        { booking_id: 'b1', event_id: 101 },
        { booking_id: 'b2', event_id: 102 },
      ]),
    });
    await run(client, matched);

    expect(client.calls[0]).toMatchObject({
      method: 'GET',
      path: 'memberships',
      params: { contact_key: 'ck-known' },
    });
  });

  it('skips the grant when the held pass reaches the last session', async () => {
    const client = makeClient({
      'GET memberships': ok([pass('2026-08-01', '2027-01-28')]),
      'POST bookings': nth => ok({ booking_id: `b${nth}` }),
      'GET bookings': ok([
        { booking_id: 'b1', event_id: 101 },
        { booking_id: 'b2', event_id: 102 },
      ]),
    });
    const out = await run(client, matched);

    expect(out.pass.state).toBe('covering');
    expect(client.calls.some(c => c.method === 'POSTFORM')).toBe(false);
    expect(out.outcome).toBe('complete');
  });

  it('grants a pass when the held one has expired, form-encoded, starting today', async () => {
    const client = makeClient({
      'GET memberships': nth =>
        nth === 1
          ? ok([pass('2026-01-01', '2026-03-25')])
          : ok([pass('2026-01-01', '2026-03-25'), pass(TODAY, '2027-02-17')]),
      'POSTFORM memberships': ok({ id: 2627746 }),
      'POST bookings': nth => ok({ booking_id: `b${nth}` }),
      'GET bookings': ok([
        { booking_id: 'b1', event_id: 101 },
        { booking_id: 'b2', event_id: 102 },
      ]),
    });
    const out = await run(client, matched);

    const grant = client.calls.find(c => c.method === 'POSTFORM');
    expect(grant.form).toMatchObject({
      contact_key: 'ck-known',
      membership_plan_id: String(PLAN),
      start_date: TODAY,
    });
    expect(out.pass).toMatchObject({ state: 'granted', expiration_date: '2027-02-17' });
  });

  it('verifies the granted pass by re-reading it, never by the status code', async () => {
    // A 200 whose pass does not cover the term is a grant that did not do the
    // job, and it looks identical to one that did from the response alone.
    const client = makeClient({
      'GET memberships': nth =>
        nth === 1 ? ok([]) : ok([pass(TODAY, '2026-09-05')]),
      'POSTFORM memberships': ok({ id: 1 }),
    });
    const out = await run(client, matched);

    expect(out).toMatchObject({ ok: false, reason: 'pass-unverified' });
    expect(client.calls.some(c => c.path === 'bookings')).toBe(false);
  });

  it('REFUSES to grant a second pass to a live holder whose pass is short — #90', async () => {
    const client = makeClient({
      'GET memberships': ok([pass('2026-08-01', '2026-09-05')]),
    });
    const out = await run(client, matched);

    expect(out).toMatchObject({
      ok: false,
      outcome: 'needs-confirmation',
      written: false,
      stranded: false,
    });
    expect(out.pass.state).toBe('needs-confirmation');
    // Nothing permanent, and nothing booked.
    expect(client.calls).toHaveLength(1);
  });

  it('names both dates on the needs-confirmation row so a human can decide', async () => {
    const client = makeClient({ 'GET memberships': ok([pass('2026-08-01', '2026-09-05')]) });
    const out = await run(client, matched);

    expect(out.pass.detail).toContain('2026-09-05');
    expect(out.pass.detail).toContain('2026-09-10');
  });

  it('refuses the whole student when the membership read fails', async () => {
    const client = makeClient({ 'GET memberships': res({ status: 500 }) });
    const out = await run(client, matched);

    expect(out).toMatchObject({ ok: false, outcome: 'failed', written: false });
    expect(client.calls.some(c => c.path === 'bookings')).toBe(false);
  });

  it('reports a throttle as itself, so the page can pause the whole run', async () => {
    const client = makeClient({
      'GET memberships': res({ status: 429, bodyText: '<html>slow down</html>' }),
    });
    const out = await run(client, matched);

    expect(out.reason).toBe('throttled');
  });
});

// ---------------------------------------------------------------------------
// D3 — all-or-nothing per student, with rollback
// ---------------------------------------------------------------------------

describe('all-or-nothing, with rollback', () => {
  const matchedCovering = {
    contactKey: 'ck-known',
    // Three sessions, so there is something to roll back when the third fails.
    events: [
      { event_id: 101, starts_at: '2026-09-03T02:00:00Z' },
      { event_id: 102, starts_at: '2026-09-10T02:00:00Z' },
      { event_id: 103, starts_at: '2026-09-17T02:00:00Z' },
    ],
  };

  const withBookings = booking =>
    makeClient({
      'GET memberships': ok([pass('2026-08-01', '2027-01-28')]),
      'POST bookings': booking,
      'GET bookings': ok([]),
      'DELETE bookings/:id': ok({ success: true }),
    });

  it('cancels the bookings it already made when a later one is refused', async () => {
    const client = withBookings(nth =>
      nth < 3 ? ok({ booking_id: `b${nth}` }) : refused(NO_FREE_SPACES),
    );
    const out = await run(client, matchedCovering);

    expect(out.outcome).toBe('abandoned');
    expect(out.rollback).toMatchObject({ cancelled: 2 });
    expect(client.calls.filter(c => c.method === 'DELETE').map(c => c.path)).toEqual([
      'bookings/b1',
      'bookings/b2',
    ]);
  });

  it('names the student as stranded, because an abandoned one always is', async () => {
    const client = withBookings(nth =>
      nth < 3 ? ok({ booking_id: `b${nth}` }) : refused(CLASS_CLOSED),
    );
    const out = await run(client, matchedCovering);

    expect(out.stranded).toBe(true);
    expect(out.strandedDetail).toBeTruthy();
  });

  it('never cancels a row Clubworx said was already booked', async () => {
    // The interlock, with no human present. That booking belongs to a previous
    // run or to the member themselves.
    const client = withBookings(nth => {
      if (nth === 1) return refused(ALREADY_BOOKED);
      if (nth === 2) return ok({ booking_id: 'b2' });
      return refused(NO_FREE_SPACES);
    });
    const out = await run(client, matchedCovering);

    expect(client.calls.filter(c => c.method === 'DELETE').map(c => c.path)).toEqual(['bookings/b2']);
    expect(out.rollback.skipped).toBeGreaterThan(0);
  });

  it('does not abandon a student whose rows are merely already booked', async () => {
    // D5's restart-safe re-run: every row already booked is a complete student.
    const client = makeClient({
      'GET memberships': ok([pass('2026-08-01', '2027-01-28')]),
      'POST bookings': refused(ALREADY_BOOKED),
      'GET bookings': ok([
        { booking_id: 'x1', event_id: 101 },
        { booking_id: 'x2', event_id: 102 },
        { booking_id: 'x3', event_id: 103 },
      ]),
    });
    const out = await run(client, matchedCovering);

    expect(out).toMatchObject({ ok: true, outcome: 'complete', stranded: false });
    expect(client.calls.some(c => c.method === 'DELETE')).toBe(false);
  });

  it('rolls back when the verification read shows a booking did not land', async () => {
    const client = makeClient({
      'GET memberships': ok([pass('2026-08-01', '2027-01-28')]),
      'POST bookings': nth => ok({ booking_id: `b${nth}` }),
      // Only two of the three are actually there.
      'GET bookings': ok([
        { booking_id: 'b1', event_id: 101 },
        { booking_id: 'b2', event_id: 102 },
      ]),
      'DELETE bookings/:id': ok({ success: true }),
    });
    const out = await run(client, matchedCovering);

    expect(out).toMatchObject({ outcome: 'abandoned', reason: 'bookings-unverified' });
    expect(out.rollback.cancelled).toBe(3);
  });

  it('does NOT roll back when the verification read itself fails', async () => {
    // A failed read is not a failed write. Cancelling good bookings because a
    // verification request timed out would destroy the thing being checked.
    const client = makeClient({
      'GET memberships': ok([pass('2026-08-01', '2027-01-28')]),
      'POST bookings': nth => ok({ booking_id: `b${nth}` }),
      'GET bookings': res({ status: 503 }),
      'DELETE bookings/:id': ok({ success: true }),
    });
    const out = await run(client, matchedCovering);

    expect(out).toMatchObject({ ok: false, outcome: 'unverified', reason: 'bookings-unread' });
    expect(client.calls.some(c => c.method === 'DELETE')).toBe(false);
    // The rows still travel, so the human control can act on them.
    expect(out.bookings.map(b => b.booking_id)).toEqual(['b1', 'b2', 'b3']);
  });

  it('reports a rollback that itself failed, rather than claiming it worked', async () => {
    const client = makeClient({
      'GET memberships': ok([pass('2026-08-01', '2027-01-28')]),
      'POST bookings': nth => (nth < 3 ? ok({ booking_id: `b${nth}` }) : refused(CLASS_CLOSED)),
      'GET bookings': ok([]),
      'DELETE bookings/:id': res({ status: 500 }),
    });
    const out = await run(client, matchedCovering);

    expect(out.rollback.cancelled).toBe(0);
    expect(out.rollback.failed).toHaveLength(2);
  });

  it('retries a booking that failed on a 5xx, since Clubworx refuses its own duplicate', async () => {
    const client = makeClient({
      'GET memberships': ok([pass('2026-08-01', '2027-01-28')]),
      'POST bookings': nth => (nth === 1 ? res({ status: 502 }) : ok({ booking_id: `b${nth}` })),
      'GET bookings': ok([
        { booking_id: 'b2', event_id: 101 },
        { booking_id: 'b3', event_id: 102 },
      ]),
    });
    const out = await run(client, { contactKey: 'ck-known' });

    expect(out.outcome).toBe('complete');
    expect(client.calls.filter(c => c.method === 'POST' && c.path === 'bookings')).toHaveLength(3);
  });

  it('gives up after the second attempt rather than hammering a throttled API', async () => {
    const client = makeClient({
      'GET memberships': ok([pass('2026-08-01', '2027-01-28')]),
      'POST bookings': res({ status: 429 }),
      'GET bookings': ok([]),
      'DELETE bookings/:id': ok({ success: true }),
    });
    const out = await run(client, { contactKey: 'ck-known' });

    expect(out.reason).toBe('throttled');
    expect(client.calls.filter(c => c.method === 'POST' && c.path === 'bookings')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// What the result carries back
// ---------------------------------------------------------------------------

describe('the result', () => {
  it('counts the requests it spent, because the allowance is gym-wide', async () => {
    const client = makeClient({
      'GET memberships': ok([pass('2026-08-01', '2027-01-28')]),
      'POST bookings': nth => ok({ booking_id: `b${nth}` }),
      'GET bookings': ok([
        { booking_id: 'b1', event_id: 101 },
        { booking_id: 'b2', event_id: 102 },
      ]),
    });
    const out = await run(client, { contactKey: 'ck-known' });

    // 1 membership read + 2 bookings + 1 verification read.
    expect(out.requests).toBe(4);
  });

  it('carries no student name or date of birth in anything it hands back', async () => {
    const client = makeClient({
      'GET memberships': ok([pass('2026-08-01', '2026-09-05')]),
    });
    const out = await run(client, { contactKey: 'ck-known' });

    const text = JSON.stringify(out);
    expect(text).not.toContain(STUDENT.first_name);
    expect(text).not.toContain(STUDENT.dob);
  });

  it('repeats an unrecognised Clubworx message verbatim — D6', async () => {
    const strange = 'The instructor has locked this session.';
    const client = makeClient({
      'GET memberships': ok([pass('2026-08-01', '2027-01-28')]),
      'POST bookings': refused(strange),
      'GET bookings': ok([]),
    });
    const out = await run(client, { contactKey: 'ck-known' });

    expect(JSON.stringify(out)).toContain(strange);
    expect(out.bookings[0].refusal).toBe('unknown');
  });
});
