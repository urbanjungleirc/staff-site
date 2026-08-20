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
import { sharedPacer } from './pace.js';

/** How much of a non-JSON body is worth keeping to diagnose a throttle or a WAF block. */
const BODY_TEXT_LIMIT = 500;

/**
 * Everything that leaves this module as free text goes through here.
 *
 * `redact` removes the account key and nothing else, which is not enough on its
 * own: both runtimes interpolate the failing request URL into a connection
 * error, and that URL carries the query as well as the key. So the key goes,
 * and any query string hanging off a URL goes with it.
 */
function scrub(text, accountKey) {
  return redact(String(text), accountKey).replace(/(https?:\/\/\S+?)\?\S*/g, '$1');
}

/**
 * A body and the Content-Type it has to be sent with — one concept, not two
 * independent flags. Clubworx wants JSON for a create and form encoding for a
 * delete, and pairing them here is what stops a caller sending one with the
 * other's header.
 */
function encodeBody({ json: payload, form }) {
  if (payload !== undefined) {
    return {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    };
  }
  if (form !== undefined) {
    return {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    };
  }
  return { headers: {}, body: undefined };
}

/** One shape for every outcome, so a caller never has to ask which kind it got. */
const outcome = ({
  ok,
  status,
  endpoint,
  ms,
  body = null,
  bodyText = null,
  message = null,
  networkError = false,
}) => ({
  ok,
  status,
  url: endpoint,
  ms,
  body,
  nonJson: body === null && !networkError,
  bodyText,
  message,
  networkError,
});

/**
 * @param {object} opts
 * @param {string} opts.accountKey
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {typeof sharedPacer} [opts.pacer]
 */
export function createClubworxClient({ accountKey, fetchImpl = fetch, pacer = sharedPacer }) {
  if (!accountKey) {
    throw new Error('createClubworxClient: an account key is required; refusing to call anonymously');
  }

  const send = async ({ method, path, params, json: payload, form }) => {
    const url = buildUrl({ path, accountKey, params });

    // The endpoint WITHOUT its query, and it is the only form that leaves this
    // module. The obvious use of a url field is a log line, and the query is
    // where `?last_name=&dob=` puts a student's surname and date of birth —
    // §6/D10. redact() would not catch that: it removes the account key and
    // nothing else. Dropping the query is what makes the rule hold here.
    const endpoint = redact(url.split('?')[0], accountKey);

    const { headers, body: requestBody } = encodeBody({ json: payload, form });
    const started = Date.now();

    return pacer(async () => {
      try {
        const res = await fetchImpl(url, {
          method,
          headers: { Accept: 'application/json', ...headers },
          ...(requestBody !== undefined ? { body: requestBody } : {}),
        });

        const text = await res.text();

        // A throttle or a WAF block answers in HTML. Parsing must not be what
        // decides whether the caller gets a usable result.
        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }

        return outcome({
          ok: res.ok,
          status: res.status,
          endpoint,
          ms: Date.now() - started,
          body: parsed,
          bodyText: parsed === null ? scrub(text, accountKey).slice(0, BODY_TEXT_LIMIT) : null,
          message: errorMessageOf(parsed),
        });
      } catch (err) {
        return outcome({
          ok: false,
          // 0 rather than null, so a caller comparing statuses cannot mistake a
          // connection failure for an upstream answer it simply did not read.
          status: 0,
          endpoint,
          ms: Date.now() - started,
          // Both runtimes interpolate the request URL into connection errors,
          // and that URL carries the key and the query.
          message: scrub(err?.message ?? err?.code ?? 'unknown error', accountKey),
          networkError: true,
        });
      }
    });
  };

  /**
   * The measured form-encoded shape carries `account_key` **in the body as well
   * as the query**, and both calls that use it were measured that way — the
   * `POST /memberships` that worked (#60) and the `DELETE /bookings/:id` that
   * worked (#60) after #50 had spent a week reporting that deletes were
   * forbidden.
   *
   * Sending it in the query alone has never been tried. It might well be
   * enough; the point is that nobody knows, and the cost of finding out the hard
   * way is asymmetric — the failure looks like `401 "Authorization failed"`,
   * which is indistinguishable from a key without permission and has already
   * cost this effort an architectural route once.
   *
   * Injected here rather than passed in, so no caller has to hold the account
   * key to send a form body. That is the property that keeps the key inside this
   * module.
   */
  const withKey = form => ({ account_key: accountKey, ...form });

  return {
    /** @param {string} path @param {Record<string, string|number|undefined>} [params] */
    get: (path, params = {}) => send({ method: 'GET', path, params }),

    /**
     * A contact create or a booking. **JSON** body; Clubworx answers 200, not 201.
     *
     * The encoding is per-endpoint, not per-API: `/members` and `/bookings` take
     * JSON (#49, #60, #63); `/memberships` takes a form. Do not unify them.
     */
    post: (path, payload, params = {}) => send({ method: 'POST', path, params, json: payload }),

    /**
     * A membership assignment. **Form-encoded** — measured on `POST /memberships`
     * (#60), and deliberately not the same shape as `post`.
     */
    postForm: (path, form, params = {}) =>
      send({ method: 'POST', path, params, form: withKey(form) }),

    /** Form-encoded, and `contact_key` is not optional. */
    del: (path, form, params = {}) => send({ method: 'DELETE', path, params, form: withKey(form) }),
  };
}
