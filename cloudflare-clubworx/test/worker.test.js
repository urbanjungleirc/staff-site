import { describe, it, expect } from 'vitest';
import { createHandler, PREFIX } from '../src/index.js';

// The Worker's front door. Two things are being pinned here and they pull in
// opposite directions, which is why they are tested together:
//
//   - It fails closed. No valid Access assertion, no answer — and the client is
//     told nothing about *why*, because "wrong-audience" and "bad-signature" are
//     a map of the gate for anyone probing it.
//   - It logs enough to attribute a write, and no more. The operator email and
//     the route go in the log line. The query string, the body and the key do
//     not — §6's D10 is one careless console.log away from being untrue, and a
//     student's surname travels in `?last_name=`.

const ENV = {
  ACCESS_TEAM_DOMAIN: 'happyk.cloudflareaccess.com',
  ACCESS_AUD: '65dd83df311d06ffbc7db624cc4e88e3c4d216e716630cfaf60d6d09b7f0e939',
  CLUBWORX_ACCOUNT_KEY: 'super-secret-gym-key-1234',
};

const accepts = email => async () => ({ ok: true, email, sub: 'sub-1' });
const rejects = reason => async () => ({ ok: false, reason, email: null, sub: null });

/** A handler with a stubbed verifier and a capturing log. */
function handlerWith(verify, { env = ENV, ...deps } = {}) {
  const lines = [];
  const handle = createHandler({
    makeVerifier: () => verify,
    log: line => lines.push(line),
    ...deps,
  });
  return {
    lines,
    call: (path, init = {}) => handle(new Request(`https://ujstaff.happyk.au${path}`, init), env),
  };
}

const withJwt = { headers: { 'Cf-Access-Jwt-Assertion': 'header.claims.signature' } };

describe('the route prefix', () => {
  it('is the one wrangler.toml routes and the design names', () => {
    expect(PREFIX).toBe('/api/clubworx');
  });

  it('answers 404 for anything outside it, without consulting Access', async () => {
    // ujstaff.happyk.au/api/* also routes to the roster Worker. Anything that
    // reaches this one by mistake is not this one's to answer.
    let consulted = false;
    const h = handlerWith(async () => {
      consulted = true;
      return { ok: true, email: 'x@y', sub: null };
    });

    const res = await h.call('/api/payments/v1/vouchers', withJwt);

    expect(res.status).toBe(404);
    expect(consulted).toBe(false);
  });

  it('does not treat a lookalike prefix as its own', async () => {
    const h = handlerWith(accepts('staff@urbanjungleirc.com'));
    expect((await h.call('/api/clubworx-other/health', withJwt)).status).toBe(404);
  });
});

describe('the Access gate', () => {
  it('refuses a request with no assertion at all', async () => {
    const h = handlerWith(rejects('no-token'));
    const res = await h.call('/api/clubworx/health');

    expect(res.status).toBe(401);
  });

  it('refuses a present-but-invalid assertion — presence is not proof', async () => {
    const h = handlerWith(rejects('bad-signature'));
    expect((await h.call('/api/clubworx/health', withJwt)).status).toBe(401);
  });

  it('refuses a token minted for a different Access application', async () => {
    const h = handlerWith(rejects('wrong-audience'));
    expect((await h.call('/api/clubworx/health', withJwt)).status).toBe(401);
  });

  it('tells the client nothing about why', async () => {
    // The reason is a map of the gate. It belongs in our log, not in a reply to
    // whoever is rattling it.
    const h = handlerWith(rejects('wrong-audience'));
    const body = await (await h.call('/api/clubworx/health', withJwt)).json();

    expect(JSON.stringify(body)).not.toContain('wrong-audience');
    expect(body.error).toBe('unauthorized');
  });

  it('records the reason in the log line, where it is useful', async () => {
    const h = handlerWith(rejects('expired'));
    await h.call('/api/clubworx/health', withJwt);

    expect(JSON.parse(h.lines[0]).reason).toBe('expired');
    expect(JSON.parse(h.lines[0]).status).toBe(401);
  });

  it('runs before routing, so an unauthenticated caller cannot map the routes', async () => {
    const h = handlerWith(rejects('no-token'));
    // A route that does not exist still answers 401, not 404.
    expect((await h.call('/api/clubworx/does-not-exist')).status).toBe(401);
  });

  it('refuses when the Access configuration is missing, rather than opening up', async () => {
    // An unset ACCESS_AUD on a deploy must not become "let everyone through".
    const h = handlerWith(rejects('not-configured'), { env: { ...ENV, ACCESS_AUD: '' } });
    expect((await h.call('/api/clubworx/health', withJwt)).status).toBe(401);
  });
});

describe('GET /health', () => {
  it('answers 200 behind a valid assertion', async () => {
    const h = handlerWith(accepts('staff@urbanjungleirc.com'));
    const res = await h.call('/api/clubworx/health', withJwt);

    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it('names the operator Access authenticated, so a deploy check proves the gate ran', async () => {
    const h = handlerWith(accepts('staff@urbanjungleirc.com'));
    const body = await (await h.call('/api/clubworx/health', withJwt)).json();

    expect(body.email).toBe('staff@urbanjungleirc.com');
  });

  it('reports whether the Clubworx secret is set, without revealing it', async () => {
    const h = handlerWith(accepts('staff@urbanjungleirc.com'));
    const res = await h.call('/api/clubworx/health', withJwt);
    const text = await res.text();

    expect(JSON.parse(text).clubworxKey).toBe('configured');
    expect(text).not.toContain(ENV.CLUBWORX_ACCOUNT_KEY);
  });

  it('says so plainly when the secret was never put, instead of looking healthy', async () => {
    const h = handlerWith(accepts('staff@urbanjungleirc.com'), {
      env: { ...ENV, CLUBWORX_ACCOUNT_KEY: undefined },
    });
    const body = await (await h.call('/api/clubworx/health', withJwt)).json();

    expect(body.clubworxKey).toBe('missing');
  });

  it('refuses a method it does not implement', async () => {
    const h = handlerWith(accepts('staff@urbanjungleirc.com'));
    expect((await h.call('/api/clubworx/health', { ...withJwt, method: 'POST' })).status).toBe(405);
  });
});

describe('routes not built yet', () => {
  it('answers 404 for an authenticated call to a route this ticket does not add', async () => {
    // #67 adds events, plan and schools; #70 adds unbook. Until then a 404 is
    // the honest answer — not a 500, and not a silent 200.
    const h = handlerWith(accepts('staff@urbanjungleirc.com'));
    const res = await h.call('/api/clubworx/unbook', { ...withJwt, method: 'POST' });

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('not found');
  });
});

describe('the log line', () => {
  it('carries the operator, the route, the status and the timing', async () => {
    const h = handlerWith(accepts('staff@urbanjungleirc.com'));
    await h.call('/api/clubworx/health', withJwt);

    const line = JSON.parse(h.lines[0]);
    expect(line.email).toBe('staff@urbanjungleirc.com');
    expect(line.route).toBe('/api/clubworx/health');
    expect(line.method).toBe('GET');
    expect(line.status).toBe(200);
    expect(typeof line.ms).toBe('number');
  });

  it('never carries the query string, where a student surname travels', async () => {
    // GET /contacts?last_name=&dob= is a documented route (§6). Logging the
    // path with its query would put a student's surname and date of birth in
    // Cloudflare's log store — exactly what D10 forbids.
    const h = handlerWith(accepts('staff@urbanjungleirc.com'));
    await h.call('/api/clubworx/health?last_name=Nowak&dob=2009-03-02', withJwt);

    const raw = h.lines[0];
    expect(raw).not.toContain('Nowak');
    expect(raw).not.toContain('2009-03-02');
    expect(JSON.parse(raw).route).toBe('/api/clubworx/health');
  });

  it('never carries the request body', async () => {
    const h = handlerWith(accepts('staff@urbanjungleirc.com'));
    await h.call('/api/clubworx/student', {
      ...withJwt,
      method: 'POST',
      body: JSON.stringify({ first_name: 'Amelia', last_name: 'Nowak', dob: '2009-03-02' }),
    });

    expect(h.lines[0]).not.toContain('Amelia');
    expect(h.lines[0]).not.toContain('Nowak');
  });

  it('never carries the account key', async () => {
    const h = handlerWith(accepts('staff@urbanjungleirc.com'));
    await h.call('/api/clubworx/health', withJwt);

    expect(h.lines[0]).not.toContain(ENV.CLUBWORX_ACCOUNT_KEY);
  });

  it('writes one line per request, not one per branch', async () => {
    const h = handlerWith(accepts('staff@urbanjungleirc.com'));
    await h.call('/api/clubworx/health', withJwt);
    await h.call('/api/clubworx/nope', withJwt);

    expect(h.lines).toHaveLength(2);
  });

  it('is not written for traffic that is not this Worker\'s', async () => {
    const h = handlerWith(accepts('staff@urbanjungleirc.com'));
    await h.call('/api/payments/v1/vouchers', withJwt);

    expect(h.lines).toHaveLength(0);
  });
});

describe('responses', () => {
  it('answers JSON and forbids caching, since every answer is per-operator', async () => {
    const h = handlerWith(accepts('staff@urbanjungleirc.com'));
    const res = await h.call('/api/clubworx/health', withJwt);

    expect(res.headers.get('Content-Type')).toContain('application/json');
    expect(res.headers.get('Cache-Control')).toContain('no-store');
  });
});

describe('GET /contacts', () => {
  // The dedup read. What is asserted here is the *route* — validation, status
  // mapping and the log line. The three-view search itself is pinned in
  // contacts.test.js.

  const found = {
    ok: true,
    candidates: [{ contact_key: 'ck-1', first_name: 'Amelia', last_name: 'Nowak', dob: '2009-03-02' }],
    views: [{ view: 'prospects', pages: 1, rows: 1 }],
    requests: 3,
  };

  const failed = over => ({
    ok: false,
    reason: 'upstream-error',
    upstreamStatus: 500,
    view: 'members',
    message: null,
    candidates: [],
    requests: 2,
    ...over,
  });

  /** A handler whose search is stubbed, recording what the route asked it for. */
  function routeWith(result, { env = ENV } = {}) {
    const asked = [];
    const lines = [];
    const handle = createHandler({
      makeVerifier: () => accepts('staff@urbanjungleirc.com'),
      log: line => lines.push(line),
      search: async args => {
        asked.push(args);
        return typeof result === 'function' ? result(args) : result;
      },
    });
    return {
      asked,
      lines,
      call: (path, init = withJwt) => handle(new Request(`https://ujstaff.happyk.au${path}`, init), env),
    };
  }

  const query = '/api/clubworx/contacts?last_name=Nowak&dob=2009-03-02';

  it('hands back the candidate set the search merged', async () => {
    const h = routeWith(found);
    const res = await h.call(query);

    expect(res.status).toBe(200);
    expect((await res.json()).candidates).toHaveLength(1);
  });

  it('passes the surname and date of birth through to the search', async () => {
    const h = routeWith(found);
    await h.call(query);

    expect(h.asked[0]).toMatchObject({ lastName: 'Nowak', dob: '2009-03-02' });
  });

  it('reports what the search cost, so a run can be held to its budget', async () => {
    // 3 reads per student; a 25-student list spends ~75 requests on this route
    // alone, against a measured ceiling of 75/min shared with the whole gym.
    const h = routeWith(found);

    expect((await (await h.call(query)).json()).requests).toBe(3);
  });

  it('trims the surname rather than searching for a padded one', async () => {
    const h = routeWith(found);
    await h.call('/api/clubworx/contacts?last_name=%20Nowak%20&dob=2009-03-02');

    expect(h.asked[0].lastName).toBe('Nowak');
  });

  it('refuses a method it does not implement — this route is read-only', async () => {
    const h = routeWith(found);
    expect((await h.call(query, { ...withJwt, method: 'POST' })).status).toBe(405);
  });

  describe('what it refuses to ask Clubworx', () => {
    const refuses = async path => {
      const h = routeWith(found);
      const res = await h.call(path);
      return { status: res.status, body: await res.json(), asked: h.asked };
    };

    it('refuses a missing surname instead of sweeping the database', async () => {
      // Both halves of the identity key are required (§5). A surname-less query
      // is a walk through ~60,000 contacts, and it cannot conclude anything.
      const { status, asked } = await refuses('/api/clubworx/contacts?dob=2009-03-02');

      expect(status).toBe(400);
      expect(asked).toHaveLength(0);
    });

    it('refuses a blank surname, which a template can produce by accident', async () => {
      expect((await refuses('/api/clubworx/contacts?last_name=%20%20&dob=2009-03-02')).status).toBe(400);
    });

    it('refuses a missing date of birth', async () => {
      expect((await refuses('/api/clubworx/contacts?last_name=Nowak')).status).toBe(400);
    });

    it('refuses a date that is not YYYY-MM-DD', async () => {
      // Date orientation is the standing hazard on this map: 03/02/2009 is two
      // different children depending on who typed it. This route takes one form.
      expect((await refuses('/api/clubworx/contacts?last_name=Nowak&dob=02/03/2009')).status).toBe(400);
    });

    it('refuses a well-shaped date that is not a real day', async () => {
      expect((await refuses('/api/clubworx/contacts?last_name=Nowak&dob=2009-02-30')).status).toBe(400);
    });

    it('says which field it refused, without repeating the value back', async () => {
      const { body } = await refuses('/api/clubworx/contacts?last_name=Nowak&dob=02/03/2009');

      expect(body.reason).toBe('bad-request');
      expect(body.error).toMatch(/dob/);
      expect(JSON.stringify(body)).not.toContain('02/03/2009');
    });
  });

  describe('when the search cannot answer', () => {
    it('passes a throttle through as 429, because the page pauses the whole run on it', async () => {
      // §11: the allowance is gym-wide, so backing off one student while the
      // others continue just spends the next window failing. The Worker does not
      // retry — it reports, and the run decides.
      const h = routeWith(failed({ reason: 'throttled', upstreamStatus: 429, view: 'prospects' }));
      const res = await h.call(query);

      expect(res.status).toBe(429);
      expect((await res.json()).reason).toBe('throttled');
    });

    it('gives a throttle §11 wording even though the upstream body is HTML', async () => {
      // The bug this pins: a throttle answers in HTML, so `errorMessageOf` finds
      // nothing and clubworx.js falls back to `bodyText` — up to 500 characters
      // of scrubbed markup, which is non-null and would win a `??` against the
      // sentence §11 requires. The operator would meet a WAF page instead of
      // being told the cause may be another system on the same gym-wide key.
      const h = routeWith(
        failed({
          reason: 'throttled',
          upstreamStatus: 429,
          view: 'prospects',
          message: '<html><head><title>429 Too Many Requests</title></head><body>…</body></html>',
        }),
      );
      const body = await (await h.call(query)).json();

      expect(body.error).toBe(
        'Clubworx is busy — this can be caused by another system, not this page. Try again shortly.',
      );
      expect(body.error).not.toContain('html');
    });

    it('answers 502 for an upstream failure, not the upstream status', async () => {
      // Clubworx answering 401 must not reach the browser as 401 — that is the
      // Access gate's code on this Worker, and confusing the two sends an
      // operator to re-authenticate against a problem that is not theirs.
      const h = routeWith(failed({ upstreamStatus: 401, message: 'Authorization failed' }));
      const res = await h.call(query);

      expect(res.status).toBe(502);
      expect((await res.json()).upstreamStatus).toBe(401);
    });

    it('carries the upstream message verbatim, never re-worded (D6)', async () => {
      const h = routeWith(failed({ upstreamStatus: 400, message: 'Woops! Something new' }));

      expect((await (await h.call(query)).json()).error).toContain('Woops! Something new');
    });

    it('refuses a sweep that never narrowed, rather than serving a truncated list', async () => {
      const h = routeWith(
        failed({ reason: 'search-not-narrowed', upstreamStatus: 200, view: 'prospects', message: 'still full at page 3' }),
      );
      const res = await h.call(query);

      expect(res.status).toBe(502);
      expect((await res.json()).reason).toBe('search-not-narrowed');
    });

    it('never answers 200 with an empty list when the search failed', async () => {
      // An empty candidate set is read as `new`, and `new` writes a contact that
      // Clubworx cannot delete. A failure must never look like "nobody found".
      const h = routeWith(failed());
      const res = await h.call(query);

      expect(res.status).not.toBe(200);
      expect((await res.json()).candidates).toBeUndefined();
    });
  });

  it('says the key was never put, rather than failing as though Clubworx refused', async () => {
    const h = routeWith(found, { env: { ...ENV, CLUBWORX_ACCOUNT_KEY: undefined } });
    const res = await h.call(query);

    expect(res.status).toBe(503);
    expect((await res.json()).reason).toBe('not-configured');
  });

  it('keeps the student out of the log line, on every path through the route', async () => {
    // The one rule in §6/D10 that a single debugging console.log undoes. The
    // route's own query string is where a surname and a birthday travel.
    const h = routeWith(failed());
    await h.call(query);
    await h.call('/api/clubworx/contacts?last_name=Nowak');

    for (const raw of h.lines) {
      expect(raw).not.toContain('Nowak');
      expect(raw).not.toContain('2009-03-02');
    }
    expect(JSON.parse(h.lines[0]).route).toBe('/api/clubworx/contacts');
  });

  it('never lets a candidate reach the log line either', async () => {
    const h = routeWith(found);
    await h.call(query);

    expect(h.lines[0]).not.toContain('Amelia');
    expect(h.lines[0]).not.toContain('ck-1');
  });
});

// ---------------------------------------------------------------------------
// POST /student — the only route that creates permanent records (#69)
// ---------------------------------------------------------------------------

describe('POST /student', () => {
  const OPERATOR = 'staff@urbanjungleirc.com';

  const BODY = {
    student: {
      first_name: 'Ada',
      last_name: 'Wayfinder',
      dob: '2012-03-04',
      email: 'noreply+stbedes@urbanjungleirc.com',
    },
    contact_key: null,
    membership_plan_id: 64189,
    membership_duration: '26 weeks',
    events: [{ event_id: 101, starts_at: '2026-09-03T02:00:00Z' }],
  };

  const post = (body = BODY) => ({
    method: 'POST',
    headers: { ...withJwt.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const completes = over => async () => ({
    ok: true,
    outcome: 'complete',
    written: true,
    contact: { contact_key: 'ck-1', state: 'created' },
    pass: { state: 'created-with-contact' },
    bookings: [{ event_id: 101, state: 'booked', booking_id: 'b1' }],
    rollback: null,
    stranded: false,
    warnings: [],
    requests: 4,
    reason: null,
    message: null,
    ...over,
  });

  it('needs POST — a GET must not be able to write anything', async () => {
    const h = handlerWith(accepts(OPERATOR), { runStudent: completes() });
    const res = await h.call('/api/clubworx/student', withJwt);
    expect(res.status).toBe(405);
  });

  it('runs behind the Access gate like every other route', async () => {
    let ran = false;
    const h = handlerWith(rejects('expired'), {
      runStudent: async () => {
        ran = true;
        return {};
      },
    });

    const res = await h.call('/api/clubworx/student', post());

    expect(res.status).toBe(401);
    expect(ran).toBe(false);
  });

  it('refuses a body that is not JSON, without touching Clubworx', async () => {
    let ran = false;
    const h = handlerWith(accepts(OPERATOR), {
      runStudent: async () => {
        ran = true;
        return {};
      },
    });

    const res = await h.call('/api/clubworx/student', {
      method: 'POST',
      headers: { ...withJwt.headers, 'Content-Type': 'application/json' },
      body: 'not json',
    });

    expect(res.status).toBe(400);
    expect(ran).toBe(false);
  });

  it('tells a missing secret apart from a Clubworx refusal', async () => {
    const h = handlerWith(accepts(OPERATOR), {
      env: { ...ENV, CLUBWORX_ACCOUNT_KEY: '' },
      runStudent: completes(),
    });

    const res = await h.call('/api/clubworx/student', post());

    expect(res.status).toBe(503);
    expect((await res.json()).reason).toBe('not-configured');
  });

  it('hands the whole result back on a completed student', async () => {
    const h = handlerWith(accepts(OPERATOR), { runStudent: completes() });
    const res = await h.call('/api/clubworx/student', post());

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: 'complete', requests: 4 });
  });

  it('passes the page a 400 for a refusal that happened before any write', async () => {
    const h = handlerWith(accepts(OPERATOR), {
      runStudent: completes({ ok: false, outcome: 'refused', reason: 'lead-time', written: false }),
    });

    const res = await h.call('/api/clubworx/student', post());

    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe('lead-time');
  });

  it('answers 429 on a throttle, so the page pauses the whole run', async () => {
    // The allowance is gym-wide. Backing off one student while the rest continue
    // just spends the next window failing.
    const h = handlerWith(accepts(OPERATOR), {
      runStudent: completes({ ok: false, outcome: 'failed', reason: 'throttled', written: false }),
    });

    expect((await h.call('/api/clubworx/student', post())).status).toBe(429);
  });

  it('answers 200 for an abandoned student, because the rollback is a result', async () => {
    // Not an error status: a row that was written and rolled back is exactly
    // what the result table has to show, and it must survive the round trip.
    const h = handlerWith(accepts(OPERATOR), {
      runStudent: completes({
        ok: false,
        outcome: 'abandoned',
        reason: 'no-spaces',
        written: true,
        stranded: true,
        rollback: { cancelled: 2, skipped: 0, failed: [] },
      }),
    });

    const res = await h.call('/api/clubworx/student', post());

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: 'abandoned', stranded: true });
  });

  it('answers 200 for needs-confirmation, which is a row and not a fault', async () => {
    const h = handlerWith(accepts(OPERATOR), {
      runStudent: completes({
        ok: false,
        outcome: 'needs-confirmation',
        reason: 'pass-not-covering',
        written: false,
      }),
    });

    expect((await h.call('/api/clubworx/student', post())).status).toBe(200);
  });

  it('gives the chain what the request asked for, and nothing it invented', async () => {
    let seen = null;
    const h = handlerWith(accepts(OPERATOR), {
      runStudent: async args => {
        seen = args;
        return (await completes()()) ;
      },
    });

    await h.call('/api/clubworx/student', post());

    expect(seen).toMatchObject({
      contactKey: null,
      membershipPlanId: 64189,
      membershipDuration: '26 weeks',
    });
    expect(seen.student).toMatchObject(BODY.student);
    expect(seen.events).toHaveLength(1);
  });

  it('names the operator on the log line of a write', async () => {
    // #47: one key per gym, so attribution by key is impossible. The verified
    // Access email is the only record of who ran it.
    const h = handlerWith(accepts(OPERATOR), { runStudent: completes() });
    await h.call('/api/clubworx/student', post());

    expect(JSON.parse(h.lines.at(-1))).toMatchObject({
      route: '/api/clubworx/student',
      method: 'POST',
      status: 200,
      email: OPERATOR,
    });
  });

  it('never logs the student, the body or anything from the response', async () => {
    // The single rule this Worker is one console.log away from breaking.
    const h = handlerWith(accepts(OPERATOR), { runStudent: completes() });
    await h.call('/api/clubworx/student', post());

    const logged = h.lines.join('\n');
    expect(logged).not.toContain('Wayfinder');
    expect(logged).not.toContain('2012-03-04');
    expect(logged).not.toContain('noreply+stbedes');
    expect(logged).not.toContain('ck-1');
    expect(logged).not.toContain(ENV.CLUBWORX_ACCOUNT_KEY);
  });

  it('answers no-store, like every other route on this Worker', async () => {
    const h = handlerWith(accepts(OPERATOR), { runStudent: completes() });
    const res = await h.call('/api/clubworx/student', post());
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});
