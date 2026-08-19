/**
 * uj-clubworx-api — the staff site's only path to the Clubworx API.
 *
 * staff-site#66. Part of the school group booking tool (#46); the design is
 * `docs/superpowers/specs/2026-08-19-school-group-booking-design.md` §6.
 *
 * **Why this Worker exists at all.** Clubworx issues exactly one key per gym
 * (#47) — the same key reads and writes UJ's whole ~60,000-profile contact
 * database, and is shared with the HVT Worker and every n8n workflow. staff-site
 * is a PUBLIC repo whose `pages.yml` rsyncs the entire tree into the published
 * site, so a key in the page would be a key on the open internet, permanently,
 * in git history. The browser talks to this Worker; only this Worker talks to
 * Clubworx.
 *
 * **This Worker stores nothing.** No student name, no date of birth, in any
 * Cloudflare store, KV, D1, or log (§6, D10). It is a transit, not a database.
 * There is no run store and no persistence of any kind, and the log line below
 * records the route, the status, the operator and the timing — never a body and
 * never the query string, because `?last_name=&dob=` is where a student's name
 * and date of birth travel. That rule is one debugging `console.log` away from
 * being untrue, which is why `test/worker.test.js` asserts it directly.
 *
 * **Auth is Cloudflare Access, verified rather than assumed.** See `access.js`.
 *
 * Routes are added by later tickets (#67, #68, #70). This one ships the
 * skeleton, the gate, the pacer and the request layer — deliberately, because
 * `main` is production on this repo and a page calling a route that does not
 * exist is a broken tool on the live hub (§17).
 */

import { createAccessVerifier } from './access.js';

export const PREFIX = '/api/clubworx';

const WORKER = 'uj-clubworx-api';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // Every answer is scoped to one authenticated operator. Nothing in front
      // of this Worker should ever hold one and hand it to somebody else.
      'Cache-Control': 'no-store',
    },
  });

/**
 * One verifier per isolate, so the JWKS cache inside it survives between
 * requests instead of being refetched on each one.
 */
let cachedVerifier = null;
let cachedVerifierFor = null;

function defaultMakeVerifier(env) {
  const signature = `${env.ACCESS_TEAM_DOMAIN}|${env.ACCESS_AUD}`;
  if (!cachedVerifier || cachedVerifierFor !== signature) {
    cachedVerifier = createAccessVerifier({
      teamDomain: env.ACCESS_TEAM_DOMAIN,
      aud: env.ACCESS_AUD,
    });
    cachedVerifierFor = signature;
  }
  return cachedVerifier;
}

/**
 * Build the request handler. The seams exist so the log line and the gate can be
 * asserted directly — both are things that fail silently in production.
 *
 * @param {object} [deps]
 * @param {(env: object) => (token: string|null) => Promise<object>} [deps.makeVerifier]
 * @param {(line: string) => void} [deps.log]
 */
export function createHandler({ makeVerifier = defaultMakeVerifier, log = console.log } = {}) {
  return async function handle(request, env) {
    const url = new URL(request.url);

    // `ujstaff.happyk.au/api/*` also routes to the roster Worker and
    // `/api/payments/*` to the voucher proxy. Anything that reaches this Worker
    // outside its own prefix is not its to answer, or to log.
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) {
      return json({ error: 'not found' }, 404);
    }

    const started = Date.now();
    // Only ever the path. Never url.search — see the header note.
    const route = url.pathname;
    const method = request.method;

    const done = (response, { email = null, reason = null } = {}) => {
      log(
        JSON.stringify({
          worker: WORKER,
          route,
          method,
          status: response.status,
          email,
          ms: Date.now() - started,
          ...(reason ? { reason } : {}),
        }),
      );
      return response;
    };

    // The gate runs before routing. A caller who cannot get through it should
    // not be able to learn which routes exist by watching 404s and 401s differ.
    const verify = makeVerifier(env);
    const auth = await verify(request.headers.get('Cf-Access-Jwt-Assertion'));
    if (!auth.ok) {
      // The reason goes to the log, not to the caller: told apart, "expired"
      // and "wrong-audience" describe the gate to whoever is rattling it.
      return done(json({ error: 'unauthorized' }, 401), { reason: auth.reason });
    }

    const email = auth.email;
    const path = url.pathname.slice(PREFIX.length) || '/';

    if (path === '/health') {
      if (method !== 'GET') return done(json({ error: 'method not allowed' }, 405), { email });
      return done(
        json({
          ok: true,
          worker: WORKER,
          // Echoing the operator back is what makes a post-deploy check prove
          // the gate actually ran, rather than proving the Worker is awake.
          email,
          // Whether the secret was ever put. Never the secret.
          clubworxKey: env.CLUBWORX_ACCOUNT_KEY ? 'configured' : 'missing',
          time: new Date().toISOString(),
        }),
        { email },
      );
    }

    // events, plan, schools, contacts, student and unbook arrive with #67/#68/#70.
    return done(json({ error: 'not found' }, 404), { email });
  };
}

const handle = createHandler();

export default {
  async fetch(request, env) {
    return handle(request, env);
  },
};
