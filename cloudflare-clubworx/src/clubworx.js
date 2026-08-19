/**
 * The Worker's only path to Clubworx.
 *
 * Every request shape here is measured, not read off the reference — the
 * reference has been wrong twice on this effort. In particular:
 *
 *   - `account_key` travels in the **query string** on every call, including
 *     writes. It is never a body field.
 *   - A create is `POST` with a **JSON** body, and Clubworx answers **200**, not
 *     201 (#49/#60).
 *   - `DELETE /bookings/:id` needs a **form-encoded** body carrying
 *     `contact_key`. Sent any other way it answers `401 "Authorization failed"`,
 *     which is indistinguishable from a key without delete permission — and was
 *     misread as exactly that, until #60 sent it correctly (#50/#60).
 *
 * Two rules this layer adds, both of which exist because staff-site is a public
 * repo talking to a 60,000-person production database with no sandbox:
 *
 *   - **Everything goes through the pacer.** There is no unpaced escape hatch,
 *     because the one call that skips it is the one that spends the gym's
 *     allowance (see `pace.js`).
 *   - **Nothing handed back carries the key.** The url is redacted, the error
 *     message is redacted, and a non-JSON body is redacted and truncated. Node
 *     and Workers both interpolate the request URL into connection errors, and
 *     that URL carries the key.
 *
 * On bodies: the parsed body is returned to the caller, because serving it to
 * the operator's own page is the entire job. It is never *logged* — see the log
 * line in `index.js`, which records route, status, operator and timing only.
 */

import { buildUrl, redact } from './request.js';
import { errorMessageOf } from './errors.js';
import { createPacer } from './pace.js';

/** How much of a non-JSON body is worth keeping to diagnose a throttle or a WAF block. */
const BODY_TEXT_LIMIT = 500;

/**
 * @param {object} opts
 * @param {string} opts.accountKey
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {ReturnType<typeof createPacer>} [opts.pacer]
 */
export function createClubworxClient({ accountKey, fetchImpl = fetch, pacer = createPacer() }) {
  if (!accountKey) {
    throw new Error('createClubworxClient: an account key is required; refusing to call anonymously');
  }

  const send = async ({ method, path, params, json: payload, form }) => {
    const url = buildUrl({ path, accountKey, params });
    const safeUrl = redact(url, accountKey);
    const started = Date.now();

    return pacer(async () => {
      try {
        const res = await fetchImpl(url, {
          method,
          headers: {
            Accept: 'application/json',
            ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}),
            ...(form !== undefined ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
          },
          ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
          ...(form !== undefined ? { body: new URLSearchParams(form).toString() } : {}),
        });

        const text = await res.text();

        // A throttle or a WAF block answers in HTML. Parsing must not be what
        // decides whether the caller gets a usable result.
        let body = null;
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }

        return {
          ok: res.ok,
          status: res.status,
          url: safeUrl,
          ms: Date.now() - started,
          body,
          nonJson: body === null,
          bodyText: body === null ? redact(text, accountKey).slice(0, BODY_TEXT_LIMIT) : null,
          message: errorMessageOf(body),
          networkError: false,
        };
      } catch (err) {
        return {
          ok: false,
          // 0 rather than null, so a caller comparing statuses cannot mistake a
          // connection failure for an upstream answer it simply did not read.
          status: 0,
          url: safeUrl,
          ms: Date.now() - started,
          body: null,
          nonJson: false,
          bodyText: null,
          message: redact(err?.message ?? err?.code ?? 'unknown error', accountKey),
          networkError: true,
        };
      }
    });
  };

  return {
    /** @param {string} path @param {Record<string, string|number|undefined>} [params] */
    get: (path, params = {}) => send({ method: 'GET', path, params }),

    /** A create or a booking. JSON body; Clubworx answers 200, not 201. */
    post: (path, payload, params = {}) => send({ method: 'POST', path, params, json: payload }),

    /** Form-encoded, and `contact_key` is not optional. */
    del: (path, form, params = {}) => send({ method: 'DELETE', path, params, form }),
  };
}
