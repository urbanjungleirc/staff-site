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
function handlerWith(verify, { env = ENV } = {}) {
  const lines = [];
  const handle = createHandler({ makeVerifier: () => verify, log: line => lines.push(line) });
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
    // #67/#68/#70 add events, contacts, student and unbook. Until then a 404 is
    // the honest answer — not a 500, and not a silent 200.
    const h = handlerWith(accepts('staff@urbanjungleirc.com'));
    const res = await h.call('/api/clubworx/student', { ...withJwt, method: 'POST' });

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
