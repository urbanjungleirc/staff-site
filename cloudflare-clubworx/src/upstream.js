/**
 * What a Clubworx answer means: retry it, report it, or neither.
 *
 * staff-site#69. Design: `docs/superpowers/specs/2026-08-19-school-group-booking-design.md` §11.
 *
 * One definition, because the write chain and the booking module were each
 * carrying their own copy of the same cascade and the two would drift on the
 * first fix that only landed in one. The way that drift shows up is not a test
 * failure — it is a `400` retried against a database that cannot delete what the
 * retry creates.
 *
 * **D8 — retry only `429`, network errors and `5xx`. Never a `400`.** All three
 * known 400s are permanent for that attempt, and the fourth kind is unknown by
 * definition, so retrying it is spending the gym's allowance to be told the same
 * thing again.
 *
 * A **`429` is told apart from the rest** everywhere it appears, because §11
 * pauses the *whole run* on a throttle rather than one row: the allowance is
 * gym-wide (one key per gym, #47), so backing off a single student while the
 * others continue just spends the next window failing.
 */

/**
 * May this be tried again?
 *
 * `status === 0` is the client's own marker for a connection failure that never
 * reached an answer — see `clubworx.js`, which uses 0 rather than null so a
 * caller comparing statuses cannot mistake it for an upstream reply it simply
 * did not read.
 *
 * @param {{status?: number, networkError?: boolean}} res
 */
export function isRetryable(res) {
  return (
    res?.networkError === true || res?.status === 429 || res?.status === 0 || res?.status >= 500
  );
}

/**
 * The machine-readable name for a failure, for the page to switch on.
 *
 * @param {{status?: number, networkError?: boolean}} res
 * @returns {'throttled'|'network'|'upstream-error'}
 */
export function upstreamReason(res) {
  if (res?.status === 429) return 'throttled';
  if (res?.networkError === true) return 'network';
  return 'upstream-error';
}

/**
 * The most faithful text available about a failure, and never a body.
 *
 * `message` is the client's own contract — it runs `errorMessageOf` over every
 * JSON body, and puts the scrubbed reason there on a connection failure.
 * `bodyText` is the leftover case: a throttle or a WAF block answering in HTML,
 * already redacted and truncated by the client.
 *
 * Both are safe to show. Neither is a record field, so no student travels in
 * one — the extraction is bounded to the `error`-shaped fields on purpose
 * (`errors.js`).
 *
 * @param {{message?: string|null, bodyText?: string|null}} res
 * @returns {string|null}
 */
export function upstreamMessage(res) {
  return res?.message ?? res?.bodyText ?? null;
}
