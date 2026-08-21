/**
 * Walking a Clubworx list to its end, when nothing in the response says where
 * the end is.
 *
 * staff-site#67. Design: `docs/superpowers/specs/2026-08-19-school-group-booking-design.md`
 * §8, §13.
 *
 * ---------------------------------------------------------------------------
 * The one fact this module exists for
 * ---------------------------------------------------------------------------
 * Clubworx sends **no total, no next-page link and no header** on any list
 * endpoint. So a page that came back exactly full is *indistinguishable from a
 * complete list* by anything in the response, and reading one as an answer is
 * the failure mode that has already cost this effort real time twice:
 *
 *   - `GET /events` returned exactly **50** — the default `page_size` — where a
 *     three-month window holds hundreds (#51). A staff member seeing 50 rows has
 *     no way to know the session they want is on page 2.
 *   - `GET /membership_plans` returned exactly **50** when UJ has **57**, and
 *     **School Pass was among the seven that never arrived** (#60). A lookup on
 *     the default page reports "no such plan" and stops the whole run, for a plan
 *     that plainly exists.
 *
 * Two rules follow, and they are the whole of this function: **ask for a page
 * size past the default**, and **treat a short page as the end and a full page as
 * unfinished**. A full page costs one more request to resolve; that is the price
 * of not truncating in silence.
 *
 * ---------------------------------------------------------------------------
 * What the ceiling means is the caller's to decide
 * ---------------------------------------------------------------------------
 * Running out of pages is reported as `truncated`, never interpreted here. It
 * means different things on different routes — a picker shows what it has and
 * says the window needs narrowing, while a plan lookup must refuse rather than
 * report a name missing from a list it never finished reading — and collapsing
 * that difference is how "not found" comes to mean "not looked for".
 *
 * ---------------------------------------------------------------------------
 * Why `contacts.js` does not use this
 * ---------------------------------------------------------------------------
 * The dedup read walks the same way but concludes differently: a full page at its
 * ceiling means *the query did not narrow*, which is a refusal
 * (`search-not-narrowed`) rather than a flag, because ignoring it writes a
 * permanent duplicate contact. It also merges rows into a Map per page instead of
 * accumulating them. Converting it is a behaviour-preserving change to the one
 * read whose failure creates records Clubworx cannot delete, so it belongs in its
 * own ticket rather than riding along here.
 *
 * ---------------------------------------------------------------------------
 * Nothing here retries
 * ---------------------------------------------------------------------------
 * Deliberately, and the same way `contacts.js` does not. §11's D8 retries `429`,
 * `5xx` and network errors — but **a `429` pauses the whole run, not one row**,
 * because the allowance is gym-wide (one key per gym, #47) and backing off a
 * single read while the rest continue just spends the next window failing.
 * Retrying inside the Worker would hide the throttle from the only layer that
 * can act on it. These are reads: they create nothing, so a caller re-asking is
 * cheap and safe, and failing fast puts the decision where it belongs.
 */

import { upstreamMessage, upstreamReason } from './upstream.js';

/**
 * Never the default 50 — that default is the trap above. 200 is the ceiling #51
 * verified, and the same cap holds across this API.
 */
export const PAGE_SIZE = 200;

/**
 * Walk one Clubworx list endpoint to exhaustion.
 *
 * @param {object} opts
 * @param {{get: (path: string, params: object) => Promise<object>}} opts.client
 *   A `createClubworxClient` instance. Everything it sends is paced.
 * @param {string} opts.path The endpoint, e.g. `'events'`.
 * @param {object} [opts.params] Everything except `page` and `page_size`.
 * @param {number} opts.maxPages How far to walk before reporting `truncated`.
 * @param {number} [opts.pageSize]
 * @param {string} [opts.what] What the rows are, for the not-a-list message.
 * @param {number} [opts.requests] A running count to continue, when a caller
 *   walks more than one list for a single answer.
 * @returns {Promise<{ok: true, rows: object[], pages: number, requests: number, truncated: boolean}
 *                 | {ok: false, reason: string, message: string|null,
 *                    upstreamStatus: number, requests: number}>}
 */
export async function pageThrough({
  client,
  path,
  params = {},
  maxPages,
  pageSize = PAGE_SIZE,
  what = 'rows',
  requests = 0,
}) {
  const rows = [];
  let pages = 0;
  let truncated = false;

  for (let page = 1; page <= maxPages; page += 1) {
    const res = await client.get(path, { ...params, page, page_size: pageSize });
    requests += 1;
    pages += 1;

    if (!res.ok) {
      // A throttle travels as itself, told apart from every other failure,
      // because §11 pauses the *whole run* on one and nothing else.
      return {
        ok: false,
        reason: upstreamReason(res),
        message: upstreamMessage(res),
        upstreamStatus: res.status,
        requests,
      };
    }

    // Measured: these endpoints answer with a bare array (#49, #51, #60).
    // Anything else is a response nobody here has seen, and reading it as "no
    // rows" is the single wrong guess that turns an anomaly into an empty
    // picker or a plan reported missing.
    if (!Array.isArray(res.body)) {
      return {
        ok: false,
        reason: 'upstream-error',
        message: `${path} answered ${res.status} with a body that is not a list of ${what}`,
        upstreamStatus: res.status,
        requests,
      };
    }

    rows.push(...res.body);

    // A short page is the end of the list — the only end-of-list signal there
    // is. A full page is ambiguous, so it costs one more request to find out.
    if (res.body.length < pageSize) break;
    if (page === maxPages) truncated = true;
  }

  return { ok: true, rows, pages, requests, truncated };
}
