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
 * Routes arrive a ticket at a time. #66 shipped the skeleton, the gate, the
 * pacer and the request layer; #68 added `GET /contacts`. The remaining ones —
 * events, plan, schools, student and unbook — belong to #67, #69 and #70, and
 * answer 404 until then, deliberately: `main` is production on this repo and a
 * page calling a route that does not exist is a broken tool on the live hub
 * (§17).
 */

import { createAccessVerifier } from './access.js';
import { createClubworxClient } from './clubworx.js';
import { searchContacts } from './contacts.js';

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
 * `YYYY-MM-DD`, and a real day.
 *
 * Strict on purpose. Date orientation is the standing hazard on this map —
 * `03/02/2009` is two different children depending on who typed it, and the
 * damage from getting it wrong is a permanent contact keyed to the wrong
 * birthday, which then poisons the surname + DOB key for every later term. The
 * parser resolves orientation before anything reaches here; this route accepts
 * one form so an unresolved date cannot slip past as a search that finds nothing.
 */
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function isRealDay(value) {
  if (!ISO_DAY.test(value)) return false;
  // `new Date('2009-02-30')` does not throw — it rolls forward to 2 March. The
  // round-trip is what catches it.
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * The default search: build a paced Clubworx client from `env` and sweep the
 * three status views. Injected in tests so the route's own behaviour — its
 * validation, its status mapping and its log line — is asserted without a
 * network stub standing in the way.
 */
const defaultSearch = ({ env, lastName, dob }) =>
  searchContacts({
    client: createClubworxClient({ accountKey: env.CLUBWORX_ACCOUNT_KEY }),
    lastName,
    dob,
  });

/**
 * Build the request handler. The seams exist so the log line and the gate can be
 * asserted directly — both are things that fail silently in production.
 *
 * @param {object} [deps]
 * @param {(env: object) => (token: string|null) => Promise<object>} [deps.makeVerifier]
 * @param {(line: string) => void} [deps.log]
 * @param {(args: {env: object, lastName: string, dob: string}) => Promise<object>} [deps.search]
 */
export function createHandler({
  makeVerifier = defaultMakeVerifier,
  log = console.log,
  search = defaultSearch,
} = {}) {
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

    if (path === '/contacts') {
      if (method !== 'GET') return done(json({ error: 'method not allowed' }, 405), { email });

      const lastName = (url.searchParams.get('last_name') ?? '').trim();
      const dob = (url.searchParams.get('dob') ?? '').trim();

      // Both halves of the identity key or nothing. A surname-less query is a
      // walk through ~60,000 contacts that can conclude nothing, and a query
      // with no date of birth cannot tell siblings apart — §5. The refusal names
      // the field and never echoes the value, because the value is the student.
      if (!lastName) {
        return done(json({ error: 'last_name is required', reason: 'bad-request' }, 400), { email });
      }
      if (!isRealDay(dob)) {
        return done(
          json({ error: 'dob is required, as a real YYYY-MM-DD day', reason: 'bad-request' }, 400),
          { email },
        );
      }

      // A missing secret is a deploy that was never finished, not a Clubworx
      // refusal. Told apart because they send an operator to different people.
      if (!env.CLUBWORX_ACCOUNT_KEY) {
        return done(
          json({ error: 'the Clubworx account key is not configured', reason: 'not-configured' }, 503),
          { email },
        );
      }

      const result = await search({ env, lastName, dob });

      if (!result.ok) {
        // A throttle is the one upstream status that travels as itself: §11 has
        // the page pause the *whole run* on a 429, because the allowance is
        // gym-wide and backing off one student while the rest continue just
        // spends the next window failing.
        //
        // Everything else becomes 502. Passing Clubworx's own code through would
        // put a 401 from Clubworx beside the 401 this Worker's Access gate
        // returns, and send an operator to re-authenticate against a problem
        // that is not theirs.
        const status = result.reason === 'throttled' ? 429 : 502;
        return done(
          json(
            {
              // Verbatim, never re-worded — D6. #50 is the cautionary tale: a
              // truthful-sounding paraphrase pointed at the wrong mechanism and
              // cost an architectural route.
              error:
                result.message ??
                (result.reason === 'throttled'
                  ? 'Clubworx is busy — this can be caused by another system, not this page. Try again shortly.'
                  : 'the Clubworx contact search failed'),
              reason: result.reason,
              view: result.view ?? null,
              upstreamStatus: result.upstreamStatus ?? null,
              requests: result.requests ?? 0,
            },
            status,
          ),
          { email },
        );
      }

      return done(
        json({ candidates: result.candidates, views: result.views, requests: result.requests }),
        { email },
      );
    }

    // events, plan, schools, student and unbook arrive with #67/#69/#70.
    return done(json({ error: 'not found' }, 404), { email });
  };
}

const handle = createHandler();

export default {
  async fetch(request, env) {
    return handle(request, env);
  },
};
