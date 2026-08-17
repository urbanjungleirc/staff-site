/**
 * The only path a probe takes to Clubworx.
 *
 * Deliberately narrow: it issues GET, it redacts, and it never throws. Probes
 * on this map (staff-site#48–#51) run against production because Clubworx has
 * no sandbox, so "read-only" has to be a property of the code rather than a
 * promise in a comment.
 */

import { buildUrl, redact } from './request.mjs';
import { rateLimitHeaders } from './report.mjs';

/**
 * @param {object} opts
 * @param {string} opts.accountKey
 * @param {typeof fetch} [opts.fetchImpl]
 * @returns {((path: string, params?: object) => Promise<object>) & { calls: number }}
 */
export function createGetter({ accountKey, fetchImpl = fetch }) {
  const get = async (path, params = {}) => {
    const url = buildUrl({ path, accountKey, params });
    const safeUrl = redact(url, accountKey);
    get.calls += 1;

    const started = performance.now();
    try {
      const res = await fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json' } });
      const ms = Math.round(performance.now() - started);
      const bodyText = await res.text();

      // A throttle or a WAF block answers in HTML. Parsing must not be what
      // decides whether the sample gets recorded.
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
      };
    } catch (err) {
      // The url is interpolated into node's own connection errors, so the
      // message is redacted rather than trusted.
      return {
        url: safeUrl,
        status: null,
        ms: Math.round(performance.now() - started),
        headers: {},
        contentType: null,
        body: null,
        bodyText: null,
        error: redact(err.code ?? err.message ?? 'unknown error', accountKey),
      };
    }
  };

  get.calls = 0;
  return get;
}
