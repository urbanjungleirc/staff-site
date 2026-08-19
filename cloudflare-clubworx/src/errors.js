/**
 * The one thing this system is allowed to read out of a Clubworx response body.
 *
 * Promoted here from `probes/lib/report.mjs` for staff-site#66. The probes wrote
 * it against measured Clubworx behaviour and it keeps its test file; the Worker
 * needs exactly the same extraction and re-deriving it would re-derive its bugs.
 *
 * The Worker stores and logs nothing from a body (§6, D10). This function is the
 * bounded exception, and it is bounded on purpose: it reads only the
 * `error`-shaped fields — the server's complaint about **our own request** —
 * never the record fields, which is where student names and dates of birth are.
 */

/**
 * The error message out of a rejected write.
 *
 * A deliberate, bounded exception to *never record a row of production data*.
 * The rule exists because responses are drawn from a 60,000-person database —
 * but this reads the server's complaint about **the caller's own request**,
 * which is the only place the reason for a rejection is written down.
 * Discarding it leaves a refusal as "HTTP 400" and no answer to what a booking
 * actually requires.
 *
 * Bounded three ways: only the `error`-shaped fields are read, never the whole
 * body; the result is truncated; and the caller redacts before it is printed or
 * written.
 *
 * @param {unknown} body
 * @param {{limit?: number}} [opts]
 * @returns {string|null}
 */
export function errorMessageOf(body, { limit = 300 } = {}) {
  if (body === null || typeof body !== 'object') return null;

  const raw = body.error ?? body.errors ?? body.message ?? null;
  if (raw === null || raw === undefined) return null;

  // Rails-shaped APIs answer with either a string, a list, or field → messages.
  const text = Array.isArray(raw)
    ? raw.map(String).join('; ')
    : typeof raw === 'object'
      ? Object.entries(raw)
          .map(([field, messages]) => `${field}: ${[].concat(messages).map(String).join(', ')}`)
          .join('; ')
      : String(raw);

  const trimmed = text.trim();
  if (!trimmed) return null;
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}
