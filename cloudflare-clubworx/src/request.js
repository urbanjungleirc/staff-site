/**
 * Request shaping and secret redaction for every Clubworx call this repo makes.
 *
 * Written for the read-only probes; promoted here from `probes/lib/request.mjs`
 * by staff-site#66 so the Worker uses the same two functions rather than a
 * second copy of them. The probes now import it from here — there is one
 * definition of how a Clubworx URL is built and one of how the key is hidden.
 *
 * staff-site is a PUBLIC repo and Clubworx has no sandbox — every call, probe or
 * Worker, runs against the live gym database. Both functions here exist so that
 * neither the URL nor anything printed about it can carry the account key into a
 * terminal log, a Worker log line, a pasted issue comment, or a committed
 * findings document.
 */

export const CLUBWORX_BASE = 'https://app.clubworx.com/api/v2';

/**
 * Build a Clubworx api/v2 URL.
 *
 * Parameter presence is meaningful here rather than incidental: `undefined`
 * omits a parameter entirely and `''` sends it present-but-blank. staff-site#51
 * turns on telling those two apart for `contact_key`, so the distinction is
 * load-bearing and must not be normalised away.
 *
 * @param {object} opts
 * @param {string} opts.path       Endpoint path, e.g. 'events'.
 * @param {string} opts.accountKey The gym's Clubworx API key.
 * @param {Record<string, string|number|undefined>} [opts.params]
 * @param {string} [opts.base]
 * @returns {string}
 */
export function buildUrl({ path, accountKey, params = {}, base = CLUBWORX_BASE }) {
  if (!accountKey) throw new Error('buildUrl: an account key is required');

  const search = new URLSearchParams();
  search.set('account_key', accountKey);

  // Sorted so two runs of the same probe produce byte-identical URLs and can be
  // diffed against each other.
  for (const name of Object.keys(params).sort()) {
    const value = params[name];
    if (value === undefined) continue;
    search.set(name, String(value));
  }

  return `${base}/${path}?${search.toString()}`;
}

const REDACTED = '<CLUBWORX_ACCOUNT_KEY>';

const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Remove the account key from any text before it is printed or written.
 *
 * Covers the percent-encoded form as well as the literal one: the key travels
 * as a query parameter, so `URLSearchParams.toString()` is where an encoded
 * copy comes from, and a naive `replaceAll` of the raw value would sail past it.
 *
 * @param {unknown} text
 * @param {string} secret
 * @returns {string}
 */
export function redact(text, secret) {
  if (!secret) throw new Error('redact: a secret is required; refusing to no-op');

  const forms = new Set([secret, encodeURIComponent(secret)]);
  let out = String(text);
  for (const form of forms) {
    out = out.replace(new RegExp(escapeRegExp(form), 'g'), REDACTED);
  }
  return out;
}
