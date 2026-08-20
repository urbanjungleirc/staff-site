/**
 * The only path a probe takes to Clubworx that can create anything.
 *
 * Kept apart from `lib/http.mjs` on purpose. That module issues GET and nothing
 * else, and the read-only probes (#51) import only it — so "this probe cannot
 * write" stays a structural property of those scripts rather than a claim about
 * them. Writing requires reaching for a different module, deliberately.
 *
 * Two controls sit in front of every request here, because Clubworx **cannot
 * delete a contact through the API** (ACCESS.md section 4) and there is no
 * sandbox:
 *
 *   1. `live` defaults to false. An import, or a forgotten flag, produces a
 *      dry-run sample instead of a permanent record.
 *   2. Every contact must pass `assertProbeIdentity`. A write under anything
 *      resembling a real person is refused before the network is touched.
 *
 * ## Which shape the body takes
 *
 * Both, on request, because this repo has measured contradictory things.
 * #49 created contacts through `POST /prospects` with a **JSON** body and got a
 * 200 — that is the only contact-create shape anyone here has seen work. But
 * the reference calls `POST /members` form-encoded, and both write paths this
 * repo *has* measured since (`/memberships` and `/bookings`, #60) are
 * form-encoded.
 *
 * staff-site#63 is the ticket that settles it, and it cannot settle it by
 * guessing: a guess that lands still leaves a permanent contact. So the
 * encoding is a parameter, it defaults to the measured shape, and an
 * unrecognised value throws rather than falling back — a probe that reported a
 * finding under a shape it did not actually send would be worse than no probe.
 */

import { buildUrl, redact } from '../../src/request.js';
import { rateLimitHeaders } from './report.mjs';
import { assertProbeIdentity } from './identity.mjs';

/**
 * Fields that exist for the write-up and the cleanup list, not for Clubworx.
 *
 * `withPlanOnCreate` is #63's marker for which contact tests the pass-on-create
 * route. Like `label` and `why` it is a note the probe keeps for itself, and
 * posting it would put a field Clubworx never asked for onto a record nobody
 * can delete.
 */
const BOOKKEEPING = new Set(['label', 'why', 'withPlanOnCreate']);

const ENCODINGS = {
  json: {
    contentType: 'application/json',
    body: payload => JSON.stringify(payload),
  },
  form: {
    contentType: 'application/x-www-form-urlencoded',
    body: payload => new URLSearchParams(payload).toString(),
  },
};

/**
 * Drop the bookkeeping fields, and anything absent.
 *
 * The absent case is not tidiness. `URLSearchParams` stringifies whatever it is
 * handed, so an optional field left `undefined` would travel as the literal
 * text `undefined` and be written onto a record that cannot be deleted.
 * `JSON.stringify` drops it silently, so the two encodings would disagree about
 * what was sent — and only one of them would be in the write-up.
 */
const payloadOf = contact =>
  Object.fromEntries(
    Object.entries(contact).filter(
      ([name, value]) => !BOOKKEEPING.has(name) && value !== undefined && value !== null,
    ),
  );

/**
 * @param {object} opts
 * @param {string} opts.accountKey
 * @param {boolean} [opts.live]  Must be explicitly true before anything is created.
 * @param {'json'|'form'} [opts.encoding]  Defaults to `json` — #49's measured shape.
 * @param {typeof fetch} [opts.fetchImpl]
 * @returns {((path: string, contact: object) => Promise<object>) & { writes: number }}
 */
export function createPoster({ accountKey, live = false, encoding = 'json', fetchImpl = fetch }) {
  const shape = ENCODINGS[encoding];
  if (!shape) {
    throw new Error(
      `unknown encoding ${JSON.stringify(encoding)} — expected 'json' or 'form'; ` +
        'refusing to fall back, because the probe would then report a finding under a shape it did not send',
    );
  }

  const post = async (path, contact) => {
    const url = buildUrl({ path, accountKey });
    const safeUrl = redact(url, accountKey);

    // Before the live check, so a dry run also proves the guard rather than
    // only proving the plumbing.
    let payload;
    try {
      assertProbeIdentity(contact);
      payload = payloadOf(contact);
    } catch (err) {
      return {
        url: safeUrl,
        encoding,
        status: null,
        ms: 0,
        headers: {},
        contentType: null,
        body: null,
        bodyText: null,
        error: null,
        refused: err.message,
        dryRun: !live,
      };
    }

    if (!live) {
      return {
        url: safeUrl,
        encoding,
        status: null,
        ms: 0,
        headers: {},
        contentType: null,
        body: null,
        bodyText: null,
        error: null,
        refused: null,
        dryRun: true,
        wouldSend: payload,
      };
    }

    post.writes += 1;
    const started = performance.now();

    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': shape.contentType },
        body: shape.body(payload),
      });
      const ms = Math.round(performance.now() - started);
      const bodyText = await res.text();

      // A validation failure or a WAF block answers in HTML, and this is
      // precisely the response worth recording — it is how question 1 and
      // question 2 get answered. Parsing must not decide whether it survives.
      let body = null;
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = null;
      }

      return {
        url: safeUrl,
        encoding,
        status: res.status,
        ms,
        headers: rateLimitHeaders(res.headers),
        contentType: res.headers.get?.('content-type') ?? null,
        body,
        bodyText: body === null ? redact(bodyText, accountKey).slice(0, 500) : null,
        error: null,
        refused: null,
        dryRun: false,
        sent: payload,
      };
    } catch (err) {
      // The url is interpolated into node's own connection errors. A failed
      // write may still have landed, so this sample is part of the cleanup
      // list, not a reason to abandon the run.
      return {
        url: safeUrl,
        encoding,
        status: null,
        ms: Math.round(performance.now() - started),
        headers: {},
        contentType: null,
        body: null,
        bodyText: null,
        error: redact(err.code ?? err.message ?? 'unknown error', accountKey),
        refused: null,
        dryRun: false,
        sent: payload,
      };
    }
  };

  post.writes = 0;
  return post;
}
