/**
 * Turning the plan *name* into the `membership_plan_id` the write chain sends.
 *
 * staff-site#67. Design: `docs/superpowers/specs/2026-08-19-school-group-booking-design.md`
 * §13; [ADR 0005](../../docs/adr/0005-school-pass-runs-26-weeks.md).
 *
 * ---------------------------------------------------------------------------
 * Why this route exists at all, rather than a constant
 * ---------------------------------------------------------------------------
 * A hard-coded `membership_plan_id` is a number nobody can check against the
 * Clubworx UI, and it is silently wrong the day somebody rebuilds the plan. The
 * name is the thing a human can verify, so the name is what the tool holds.
 *
 * ---------------------------------------------------------------------------
 * The trap: 50 of 57, and School Pass among the missing
 * ---------------------------------------------------------------------------
 * `GET /membership_plans` answered with exactly **50** plans on 2026-08-18 — the
 * default `page_size` — when UJ has **57**. School Pass was one of the seven that
 * never arrived (#60). There is no total, no next-page link and no header, so a
 * truncated page is indistinguishable from a complete list by anything in the
 * response, and a lookup on the default page reports "no such plan" and stops
 * the whole run for a plan that plainly exists.
 *
 * Two rules follow, and this module is both of them:
 *
 *   - **Ask for a page size past the default, and page to exhaustion.** A short
 *     page is the end of the list; a full page is not an answer.
 *   - **Refuse an ambiguous name.** Two plans sharing a name is an error rather
 *     than a first-wins — the wrong plan assigned is a permanent mark on a real
 *     person, and there is no delete (ACCESS.md §4).
 *
 * ---------------------------------------------------------------------------
 * `membership_duration` is the second thing this route is for
 * ---------------------------------------------------------------------------
 * The write chain takes `membership_plan_id` **and** `membership_duration` from
 * its caller (`student.js`), and this is the only place either enters the
 * system. The duration is what the pre-write coverage check runs on: the last
 * selected session has to fall inside `today + membership_duration`, or the run
 * hard-stops before anything permanent is written (§11).
 *
 * It is a **human string** — `"12 weeks"`, `"26 weeks"` — so it travels
 * **verbatim** as well as parsed. `parsePlanDuration` refuses rather than
 * guessing, and a refusal here is a warning on screen naming the raw value, not
 * a skipped check and not a failed lookup. The number 26 appears in no source
 * file, which is the point: ADR 0005 changed the pass from 12 weeks to 26 and
 * needed no code change at all.
 */

import { parsePlanDuration } from './duration.js';
import { upstreamMessage, upstreamReason } from './upstream.js';

/**
 * Never the default 50 — that default is the whole failure this module exists
 * for. 200 is the ceiling #51 verified on `/events`, and the same cap applies
 * across this API.
 */
export const PAGE_SIZE = 200;

/**
 * How far the plan list may be walked before the answer is called truncated
 * rather than complete.
 *
 * UJ has 57 plans, so page one already holds every one of them and this ceiling
 * should never be approached. It is a guard against a `page_size` that stops
 * being honoured, which would otherwise walk a list forever at 75 requests a
 * minute — and hitting it is reported as a truncation, never as "not found",
 * because the two send an operator to completely different places.
 */
export const MAX_PAGES = 5;

/**
 * Resolve a membership plan by name, and refuse to guess.
 *
 * Promoted from `probes/lib/report.mjs` (#67), where it was written against the
 * measured `/membership_plans` behaviour. The probes import it from here now, so
 * there is one definition — the same move `summariseMemberships` made in #69.
 *
 * @param {unknown} body A `GET /membership_plans` response, or the accumulated rows of several.
 * @param {string} name Exact plan name, compared case-insensitively.
 * @param {{requestedPageSize?: number|null}} [opts] When set, a body of at least
 *   this length is reported as `truncated` — a page that came back exactly full
 *   is indistinguishable from a complete list.
 */
export function findPlanByName(body, name, { requestedPageSize = null } = {}) {
  if (!Array.isArray(body)) {
    return { plan: null, matches: 0, truncated: false, count: 0, notAnArray: true };
  }

  const wanted = String(name ?? '').trim().toLowerCase();
  const matches = body.filter(p => String(p?.name ?? '').trim().toLowerCase() === wanted);

  // A page that came back exactly full is indistinguishable from a complete
  // list — there is no total and no next-page link — so "not found" on a full
  // page is not an answer.
  const truncated = requestedPageSize !== null && body.length >= requestedPageSize;

  return {
    plan: matches.length === 1 ? matches[0] : null,
    matches: matches.length,
    ambiguous: matches.length > 1,
    truncated,
    count: body.length,
    notAnArray: false,
  };
}

const failure = ({ reason, message, upstreamStatus = null, requests, matches = 0 }) => ({
  ok: false,
  reason,
  message,
  upstreamStatus,
  matches,
  plan: null,
  requests,
});

/**
 * Look one plan up by name, paging to exhaustion.
 *
 * @param {object} opts
 * @param {{get: (path: string, params: object) => Promise<object>}} opts.client
 *   A `createClubworxClient` instance. Everything it sends is paced.
 * @param {string} opts.name The plan name, as the page asked for it.
 * @returns {Promise<{ok: true, plan: object, plans: number, pages: number, requests: number}
 *                 | {ok: false, reason: string, message: string|null, upstreamStatus: number|null,
 *                    matches: number, plan: null, requests: number}>}
 */
export async function lookupPlan({ client, name }) {
  const wanted = String(name ?? '').trim();
  if (!wanted) {
    return failure({
      reason: 'bad-request',
      message: 'a plan name is required',
      requests: 0,
    });
  }

  const rows = [];
  let requests = 0;
  let pages = 0;
  let stillFullAtCeiling = false;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const res = await client.get('membership_plans', { page, page_size: PAGE_SIZE });
    requests += 1;
    pages += 1;

    if (!res.ok) {
      // A throttle travels as itself. §11 pauses the *whole run* on one, because
      // the allowance is gym-wide (one key per gym, #47) and backing off a
      // single lookup while the rest continue just spends the next window
      // failing. Everything else is an upstream error the page reports.
      return failure({
        reason: upstreamReason(res),
        message: upstreamMessage(res),
        upstreamStatus: res.status,
        requests,
      });
    }

    // Measured: this endpoint answers with a bare array (#60). Anything else is
    // a response nobody here has seen, and reading it as "no plans" would report
    // School Pass missing — the exact conclusion that stops a run for a plan
    // that exists.
    if (!Array.isArray(res.body)) {
      return failure({
        reason: 'upstream-error',
        message: `membership_plans answered ${res.status} with a body that is not a list of plans`,
        upstreamStatus: res.status,
        requests,
      });
    }

    rows.push(...res.body);

    // A short page is the end of the list — the only end-of-list signal there
    // is. A page that is exactly full is ambiguous, so it costs one more request
    // to find out; that is the price of not silently truncating.
    if (res.body.length < PAGE_SIZE) break;
    if (page === MAX_PAGES) stillFullAtCeiling = true;
  }

  // The accumulated list, so `requestedPageSize` describes the walk rather than
  // one page: only a walk that ended at the ceiling still full is truncated.
  const found = findPlanByName(rows, wanted, { requestedPageSize: null });

  if (found.ambiguous) {
    return failure({
      reason: 'plan-ambiguous',
      message:
        `${found.matches} membership plans are named "${wanted}" — refusing to guess which one. ` +
        'Assigning the wrong plan is permanent, so this needs a name that identifies exactly one.',
      matches: found.matches,
      requests,
    });
  }

  if (!found.plan) {
    if (stillFullAtCeiling) {
      // Not "no such plan". The list was never read to the end, and #60 is the
      // cautionary tale: 50 of 57 came back and School Pass was among the seven
      // missing, which reads exactly like a plan that does not exist.
      return failure({
        reason: 'plan-list-truncated',
        message:
          `the membership plan list was still returning a full page of ${PAGE_SIZE} at page ` +
          `${MAX_PAGES}, so "${wanted}" cannot be reported as missing — the list was never read to the end`,
        requests,
      });
    }

    return failure({
      reason: 'plan-not-found',
      message: `no membership plan is named "${wanted}" — ${rows.length} plans were read`,
      requests,
    });
  }

  // Clubworx calls it `id` on a plan row and `membership_plan_id` on the write
  // (measured, #60/#63). The route answers in the write's vocabulary so the
  // caller never has to know they are the same thing.
  const id = found.plan.id ?? null;
  if (id === null || id === '') {
    return failure({
      reason: 'upstream-error',
      message: `the membership plan named "${wanted}" came back without an id, so it cannot be assigned`,
      requests,
    });
  }

  const rawDuration = found.plan.membership_duration ?? null;

  return {
    ok: true,
    plan: {
      membership_plan_id: id,
      // As Clubworx spells it, not as the caller asked for it. The two differ in
      // case and spacing, and the one worth showing an operator is the one that
      // is actually configured.
      name: found.plan.name ?? wanted,
      // Verbatim, always — §11 warns on screen naming the raw value rather than
      // skipping the coverage check in silence.
      membership_duration: rawDuration,
      // Best-effort, and `ok: false` is a warning for the page, not a failure
      // here. A duration this cannot parse also cannot be guessed: a wrong
      // default is indistinguishable from a right one until a term is half over.
      duration: parsePlanDuration(rawDuration),
    },
    plans: rows.length,
    pages,
    requests,
  };
}
