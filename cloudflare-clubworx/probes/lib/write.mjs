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
 */

import { buildUrl, redact } from '../../src/request.js';
import { rateLimitHeaders } from './report.mjs';
import { assertProbeIdentity } from './identity.mjs';

/** Fields that exist for the write-up and the cleanup list, not for Clubworx. */
const BOOKKEEPING = new Set(['label', 'why']);

const payloadOf = contact =>
  Object.fromEntries(Object.entries(contact).filter(([name]) => !BOOKKEEPING.has(name)));

/**
 * @param {object} opts
 * @param {string} opts.accountKey
 * @param {boolean} [opts.live]  Must be explicitly true before anything is created.
 * @param {typeof fetch} [opts.fetchImpl]
 * @returns {((path: string, contact: object) => Promise<object>) & { writes: number }}
 */
export function createPoster({ accountKey, live = false, fetchImpl = fetch }) {
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
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
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
