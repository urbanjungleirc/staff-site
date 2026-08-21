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
 * Routes arrived a ticket at a time. #66 shipped the skeleton, the gate, the
 * pacer and the request layer; #68 added `GET /contacts`; #69 added
 * `POST /student`, the route that creates the records nothing here can delete;
 * #67 added the three reads the page opens with — `GET /events`, `GET /plan`
 * and `GET /schools`; #70 added `POST /unbook`, the only reversal this system
 * has. Every route §6 names is now here.
 */

import { createAccessVerifier } from './access.js';
import { createClubworxClient } from './clubworx.js';
import { searchContacts } from './contacts.js';
import { listEvents, resolveEvent } from './events.js';
import { lookupPlan } from './plans.js';
import { listSchools } from './schools.js';
import { runStudentChain } from './student.js';
import { unbookRun } from './unbook.js';
import { isRealDay } from './duration.js';

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

// `isRealDay` is imported rather than restated. It is strict on purpose: date
// orientation is the standing hazard on this map — `03/02/2009` is two different
// children depending on who typed it, and the damage is a permanent contact
// keyed to the wrong birthday, which then poisons the surname + DOB key for
// every later term. The parser resolves orientation before anything reaches
// here; the routes accept one form so an unresolved date cannot slip past as a
// search that finds nothing.

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
 * The default write chain: one paced client for the whole student, so the
 * membership read, the writes and the bookings all queue behind each other.
 *
 * Injected in tests for the same reason `search` is — the route's own job is
 * validation, status mapping and the log line, and every one of those fails
 * silently if a network stub is standing in the way.
 */
const defaultRunStudent = ({ env, ...args }) =>
  runStudentChain({
    client: createClubworxClient({ accountKey: env.CLUBWORX_ACCOUNT_KEY }),
    ...args,
  });

/**
 * The three reads #67 added. One paced client per call, like the others, and
 * injected in tests for the same reason — the route's own job is validation,
 * status mapping and the log line, every one of which fails silently in
 * production and none of which is visible through a network stub.
 */
const defaultReadEvents = ({ env, eventId, ...args }) => {
  const client = createClubworxClient({ accountKey: env.CLUBWORX_ACCOUNT_KEY });
  // A pasted id and a window listing are two different questions, and the id
  // answers on its own — `resolveEvent` does not take a window (see its header).
  return eventId ? resolveEvent({ client, eventId }) : listEvents({ client, ...args });
};

const defaultReadPlan = ({ env, ...args }) =>
  lookupPlan({ client: createClubworxClient({ accountKey: env.CLUBWORX_ACCOUNT_KEY }), ...args });

const defaultReadSchools = ({ env }) =>
  listSchools({ client: createClubworxClient({ accountKey: env.CLUBWORX_ACCOUNT_KEY }) });

/**
 * The cancel (#70). One paced client for the whole call, so the deletes and the
 * verifying re-read queue behind each other like every other chain here.
 */
const defaultUnbook = ({ env, ...args }) =>
  unbookRun({ client: createClubworxClient({ accountKey: env.CLUBWORX_ACCOUNT_KEY }), ...args });

/**
 * What HTTP status a failed read leaves as.
 *
 * Three groups, and the grouping is the design rather than the convention:
 *
 *   - **429 for a throttle**, and only for a throttle. §11 pauses the *whole
 *     run* on one, because the allowance is gym-wide (one key per gym, #47) and
 *     backing off a single read while the rest continue just spends the next
 *     window failing. The page needs that where it cannot be missed.
 *   - **400 for a refusal**, which is every reason the read reached an answer
 *     and declined to act on it: a missing date window, a plan name matching
 *     none or matching two, a plan list that was never read to the end, an event
 *     id nothing resolved. §11 groups all of these as *refused before any
 *     permanent write*, and `POST /student` already answers them 400.
 *
 *     Not 404 — this Worker answers 404 for a route that does not exist (see the
 *     bottom of the handler), and a page cannot tell "there is no School Pass"
 *     from "there is no /plan route" if both arrive as one number. The `reason`
 *     field is the discriminator throughout this Worker; the status only has to
 *     avoid lying.
 *   - **502 for everything else.** Passing Clubworx's own code through would put
 *     a 401 from Clubworx beside the 401 this Worker's Access gate returns, and
 *     send an operator to re-authenticate against a problem that is not theirs.
 */
const REFUSALS = new Set([
  'bad-request',
  'plan-not-found',
  'plan-ambiguous',
  'plan-list-truncated',
  'event-not-found',
]);

const readStatus = reason => (reason === 'throttled' ? 429 : REFUSALS.has(reason) ? 400 : 502);

/**
 * A failed read, as the page receives it.
 *
 * A throttle gets §11's wording and never the upstream text — it is the one case
 * where there IS no upstream message to be faithful to, because a throttle
 * answers in HTML and the client falls back to up to 500 characters of scrubbed
 * markup. Letting that win would put a WAF page in front of the operator instead
 * of the sentence that says the cause may be another system on the same gym-wide
 * key.
 *
 * Everything else travels verbatim, never re-worded — D6. #50 is the cautionary
 * tale: a truthful-sounding paraphrase pointed at the wrong mechanism and cost
 * an architectural route.
 */
const readFailure = result =>
  json(
    {
      error:
        result.reason === 'throttled'
          ? 'Clubworx is busy — this can be caused by another system, not this page. Try again shortly.'
          : (result.message ?? 'the Clubworx read failed'),
      reason: result.reason,
      upstreamStatus: result.upstreamStatus ?? null,
      // Always present rather than conditional: `GET /contacts` has answered
      // with `view: null` since #68, and a field that appears only sometimes is
      // a field a client learns to stop checking.
      view: result.view ?? null,
      ...(result.matches ? { matches: result.matches } : {}),
    },
    readStatus(result.reason),
  );

/**
 * Build the request handler. The seams exist so the log line and the gate can be
 * asserted directly — both are things that fail silently in production.
 *
 * @param {object} [deps]
 * @param {(env: object) => (token: string|null) => Promise<object>} [deps.makeVerifier]
 * @param {(line: string) => void} [deps.log]
 * @param {(args: {env: object, lastName: string, dob: string}) => Promise<object>} [deps.search]
 * @param {(args: object) => Promise<object>} [deps.runStudent]
 * @param {(args: object) => Promise<object>} [deps.readEvents]
 * @param {(args: object) => Promise<object>} [deps.readPlan]
 * @param {(args: object) => Promise<object>} [deps.readSchools]
 * @param {(args: object) => Promise<object>} [deps.unbook]
 */
export function createHandler({
  makeVerifier = defaultMakeVerifier,
  log = console.log,
  search = defaultSearch,
  runStudent = defaultRunStudent,
  readEvents = defaultReadEvents,
  readPlan = defaultReadPlan,
  readSchools = defaultReadSchools,
  unbook = defaultUnbook,
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

    const done = (response, { email = null, reason = null, outcome = null } = {}) => {
      log(
        JSON.stringify({
          worker: WORKER,
          route,
          method,
          status: response.status,
          email,
          ms: Date.now() - started,
          ...(reason ? { reason } : {}),
          // `outcome` is one of a closed set of words — complete, abandoned,
          // needs-confirmation — and never a value out of the request or the
          // response. It is here because "did this call create a permanent
          // record?" is the question an operational log has to be able to
          // answer, and a 200 alone does not.
          ...(outcome ? { outcome } : {}),
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

      // The same mapping every read on this Worker uses. This route carried its
      // own copy from #68 until #67 added three more; four copies of the 429-vs-502
      // rule and of §11's throttle sentence is how the wording drifts on the
      // first fix that only lands in one of them. `readFailure` defaults its
      // message to the generic read text, so the more specific sentence stays
      // here where the search is.
      if (!result.ok) {
        return done(
          readFailure({ ...result, message: result.message ?? 'the Clubworx contact search failed' }),
          { email },
        );
      }

      return done(
        json({ candidates: result.candidates, views: result.views, requests: result.requests }),
        { email },
      );
    }

    // The three reads the page opens with (#67). All read-only, so they answer
    // before any write path is involved — and all three share one shape: a
    // secret check, a delegated call, and `readFailure` for anything that did
    // not conclude.
    //
    // The secret check comes first in each, because a missing key is a deploy
    // that was never finished rather than a Clubworx refusal, and the two send
    // an operator to different people.
    const notConfigured = () =>
      done(
        json({ error: 'the Clubworx account key is not configured', reason: 'not-configured' }, 503),
        { email },
      );

    if (path === '/events') {
      if (method !== 'GET') return done(json({ error: 'method not allowed' }, 405), { email });
      if (!env.CLUBWORX_ACCOUNT_KEY) return notConfigured();

      // `event_id` switches this route into the paste-the-id fallback (§8) — the
      // path that survives the listing being wrong, the window being wrong, or
      // Clubworx enforcing the `contact_key` its reference documents and this
      // picker is built on ignoring. `from`/`to` still travel when present, so a
      // pasted id can be resolved out of the window the picker already knows.
      const result = await readEvents({
        env,
        eventId: (url.searchParams.get('event_id') ?? '').trim(),
        from: (url.searchParams.get('from') ?? '').trim(),
        to: (url.searchParams.get('to') ?? '').trim(),
        q: (url.searchParams.get('q') ?? '').trim(),
      });

      if (!result.ok) return done(readFailure(result), { email });
      return done(json(result), { email });
    }

    if (path === '/plan') {
      if (method !== 'GET') return done(json({ error: 'method not allowed' }, 405), { email });
      if (!env.CLUBWORX_ACCOUNT_KEY) return notConfigured();

      const result = await readPlan({ env, name: (url.searchParams.get('name') ?? '').trim() });

      if (!result.ok) return done(readFailure(result), { email });
      return done(json(result), { email });
    }

    if (path === '/schools') {
      if (method !== 'GET') return done(json({ error: 'method not allowed' }, 405), { email });
      if (!env.CLUBWORX_ACCOUNT_KEY) return notConfigured();

      const result = await readSchools({ env });

      if (!result.ok) return done(readFailure(result), { email });
      return done(json(result), { email });
    }

    if (path === '/student') {
      if (method !== 'POST') return done(json({ error: 'method not allowed' }, 405), { email });

      // A missing secret is a deploy that was never finished, not a Clubworx
      // refusal — and on this route the difference matters more than anywhere
      // else, because the caller is about to be told a student was not created.
      if (!env.CLUBWORX_ACCOUNT_KEY) {
        return done(
          json({ error: 'the Clubworx account key is not configured', reason: 'not-configured' }, 503),
          { email },
        );
      }

      let payload = null;
      try {
        payload = await request.json();
      } catch {
        payload = null;
      }
      if (!payload || typeof payload !== 'object') {
        return done(
          json({ error: 'a JSON body describing one student is required', reason: 'bad-request' }, 400),
          { email },
        );
      }

      const result = await runStudent({
        env,
        student: payload.student,
        contactKey: payload.contact_key ?? null,
        membershipPlanId: payload.membership_plan_id,
        membershipDuration: payload.membership_duration,
        events: payload.events,
      });

      // **A result is not an error, even when the student was abandoned.**
      //
      // §12's result table has to show every outcome — created, already booked,
      // refused, rolled back, stranded — and D10 writes each row to the
      // browser's localStorage as it lands, because a page reload destroying the
      // only record of a creation that cannot be undone is the specific failure
      // that design defends against. A 4xx or 5xx invites a client to throw the
      // body away, and the body is the record.
      //
      // So only two things leave as a non-200, and both are conditions in which
      // there is nothing to record:
      //
      //   - **429**, because §11 pauses the *whole run* on a throttle. The
      //     allowance is gym-wide, so backing off one row while the rest
      //     continue just spends the next window failing, and the page needs
      //     that signal where it cannot be missed.
      //   - **400** for a refusal that happened before any write — a lead-time
      //     session, a pass that will not cover the term, a malformed request.
      //     Nothing was attempted, so there is no row.
      // A throttle leaves as a 429 **only when nothing was written**. Once this
      // call has created a contact, granted a pass or rolled bookings back,
      // there is a row to record, and a non-200 invites a client to throw the
      // body away — which is the body D10 writes to localStorage precisely
      // because a lost record of an un-deletable creation is unrecoverable. The
      // page still sees `reason: "throttled"` in the body and pauses the run on
      // that, which is the signal §11 actually asks for.
      const throttled = result.reason === 'throttled' && result.written !== true;
      const status = throttled ? 429 : result.outcome === 'refused' ? 400 : 200;

      return done(json(result, status), { email, outcome: result.outcome });
    }

    if (path === '/unbook') {
      if (method !== 'POST') return done(json({ error: 'method not allowed' }, 405), { email });

      // A missing secret is a deploy that was never finished, not a Clubworx
      // refusal — and here the caller is about to be told a rollback did not
      // happen, which sends an operator into Clubworx by hand.
      if (!env.CLUBWORX_ACCOUNT_KEY) return notConfigured();

      let payload = null;
      try {
        payload = await request.json();
      } catch {
        payload = null;
      }
      if (!payload || typeof payload !== 'object' || !Array.isArray(payload.bookings)) {
        return done(
          json(
            {
              error: 'a JSON body carrying this run\u2019s booking rows is required',
              reason: 'bad-request',
            },
            400,
          ),
          { email },
        );
      }

      const result = await unbook({
        env,
        // Only ever used to REJECT a row belonging to somebody else. The key
        // actually sent to Clubworx comes from the booking row — omitting it
        // answers 401 "Authorization failed", and a caller-supplied one can be
        // a different student's (§12, #50).
        contactKey: payload.contact_key ?? null,
        rows: payload.bookings,
      });

      // The same rule `POST /student` follows, and for the same reason: **a
      // result is not an error.** A partial rollback's leftover list is the only
      // record of which bookings a human still has to remove, and D10 writes it
      // to the browser's localStorage as it lands. A 4xx or 5xx invites a client
      // to throw the body away, and the body is the record.
      //
      // So only two things leave as a non-200:
      //
      //   - **429**, when the throttle cancelled nothing. §11 pauses the whole
      //     run on one, because the allowance is gym-wide. Once a cancel HAS
      //     landed there is a row to record, so it leaves as a 200 carrying
      //     `reason: "throttled"` — the signal the page actually pauses on.
      //   - **400** for a refusal that happened before anything was sent: no
      //     rows, or a set mixing two contacts. Nothing was attempted, so there
      //     is no row.
      const throttled = result.reason === 'throttled' && result.cancelled === 0;
      const status = throttled ? 429 : result.outcome === 'refused' ? 400 : 200;

      return done(json(result, status), { email, outcome: result.outcome });
    }

    return done(json({ error: 'not found' }, 404), { email });
  };
}

const handle = createHandler();

export default {
  async fetch(request, env) {
    return handle(request, env);
  },
};
