/**
 * The dedup read: does this student already exist in Clubworx?
 *
 * staff-site#68. Design: `docs/superpowers/specs/2026-08-19-school-group-booking-design.md`
 * §5 (identity and matching) and §6 (the route table).
 *
 * ---------------------------------------------------------------------------
 * The trap this module exists to avoid
 * ---------------------------------------------------------------------------
 * `/prospects`, `/members` and `/non_attending_contacts` are **three disjoint
 * views by status, not three indexes over one table** (#49). A contact appears
 * in exactly one of them and *moves between them as their status changes* —
 * and #63 measured that the view is set by whichever endpoint created the
 * contact, so it is a label, not a consequence of holding a pass.
 *
 * A prospect-only lookup therefore stops finding a student the moment they take
 * a membership. That is not hypothetical: it broke the #60 probe in practice
 * when its own test contacts were converted to members. So this searches all
 * three and merges by `contact_key`.
 *
 * ---------------------------------------------------------------------------
 * Why every uncertain answer here is a refusal
 * ---------------------------------------------------------------------------
 * The caller turns an empty candidate set into the match state `new`, and `new`
 * creates a contact. **Clubworx has no delete for contacts** (ACCESS.md §4) —
 * every one written is permanent, beside ~60,000 real people, removable only by
 * hand in the UI. So the failure modes are not symmetric: an over-broad
 * candidate set costs a human a second look, and a short one costs a duplicate
 * record that nobody can take back.
 *
 * That asymmetry is the whole design of the error handling below. A view that
 * errors, a `200` whose body is not a list, and a sweep that never narrowed all
 * **refuse the entire search** rather than answering from what did come back.
 *
 * ---------------------------------------------------------------------------
 * What it deliberately does not do
 * ---------------------------------------------------------------------------
 * **It does not decide the match.** `new` / `matched` / `name-variant` /
 * `ambiguous` is produced by `school-booking/identity.js`, which is pure so it
 * stays testable. This module narrows; it does not conclude.
 *
 * **It does not filter the rows Clubworx returned.** Matching runs on *compare
 * form* (§7 P10) — the normalisation that lets `O'Brien` match `OBrien` — and
 * that table lives in `school-booking/parse.js`, on the browser side. A second
 * copy here would drift, and the drift is silent in the worst way: the day the
 * two disagree, a student who already has a contact comes back as `new` and a
 * second permanent record is written. Nothing throws; both spellings are valid.
 * `matchStudent` already re-checks surname *and* DOB against every candidate,
 * so an over-broad set is safe and a locally-narrowed one is not.
 *
 * ---------------------------------------------------------------------------
 * Why `dob` is passed through untouched — measured, #92
 * ---------------------------------------------------------------------------
 * `dob` leaves here exactly as Clubworx sent it, and `matchStudent` compares it
 * as a string against `parse.js`'s ISO `YYYY-MM-DD`.
 *
 * That rested on an assumption until 2026-08-20, when it was checked live: **a
 * contact reads back with `dob` as ISO `YYYY-MM-DD`**, no time component — the
 * probe contact returned `1900-01-01`, the exact string it was written with. So
 * the comparison is sound and **no normalisation belongs here**.
 *
 * Keep it that way. The reason this was never normalised on a guess is worth
 * more than the finding: if the format had been `02/05/1999`, orientation would
 * have been ambiguous, and a wrong guess would have made every comparison
 * false, reported every student `new`, and written a permanent contact for each
 * — silently, since a school that has never climbed here looks exactly the
 * same. Anyone adding a date transform here is re-opening that.
 *
 * The call also returned rather than tripping the `search-not-narrowed`
 * ceiling, which proves the filtering happens server-side: with both filters
 * ignored, `/prospects` alone would have answered three full pages. Which of
 * the two narrows, and whether `last_name` is exact or partial, is still open
 * on #92 — a sizing question now, not a correctness one.
 *
 * **It does not retry.** §11's D8 retries `429`, `5xx` and network errors — but
 * *a `429` pauses the whole run, not one row*, because the allowance is
 * gym-wide (one key per gym, #47) and backing off a single student while the
 * others continue just spends the next window failing. Retrying inside the
 * Worker would hide the throttle from the only layer that can act on it, so the
 * `429` is reported as itself and the page decides.
 */

/**
 * The three disjoint status views, in the order #49 measured them.
 *
 * Adding a fourth is not a refactor: it is a claim about where Clubworx can put
 * a contact, and #49 and #63 are the evidence for these three.
 */
export const CONTACT_VIEWS = ['prospects', 'members', 'non_attending_contacts'];

/**
 * Never the default 50.
 *
 * #51 measured the default page as exactly 50 rows with **no total, no
 * next-page link and no header** to say more exist — a truncated page is
 * indistinguishable from a complete list by anything in the response. 200 is
 * verified to work.
 */
export const PAGE_SIZE = 200;

/**
 * How far a single view may be walked before the search is called broken.
 *
 * This was written when it was unknown whether Clubworx honoured `last_name`
 * and `dob` as *filters* at all — the only contact filter ever measured was
 * `email` (#49) — and an ignored filter would make every page come back full:
 * a walk through a 60,000-person database at 75 requests a minute, ~13 minutes
 * for one student, every row a stranger's name and date of birth going to a
 * browser.
 *
 * **The filtering does happen server-side** (#92, 2026-08-20). A live
 * `?last_name=&dob=` search returned instead of tripping this ceiling, which is
 * only possible if at least one filter narrows. So this is a guard against an
 * anomaly rather than the expected path, and it should not fire in normal use.
 *
 * Still worth keeping, and still worth knowing the open half: whether
 * `last_name` matches **exactly or partially** is unmeasured, and `probes/`
 * suggests partial. If it is, a common surname returns more rows than a rare
 * one, and this ceiling is what stands between that and a silent truncation.
 *
 * Three pages is generous for the intended query — a surname and a birthday
 * should match a handful — and small enough that an anomaly is caught in
 * seconds. Hitting it means the query did not narrow, which is a refusal
 * (`search-not-narrowed`), not a truncation flag: a flag is something a caller
 * can ignore, and ignoring this one writes a duplicate contact.
 */
export const MAX_PAGES = 3;

/**
 * The fields a candidate travels with, and nothing else.
 *
 * The Worker is a transit, not a database (§6, D10). `contact_key`,
 * `first_name`, `last_name` and `dob` are what `matchStudent` reads. `email`
 * carries the `noreply+<school>@` tag, which is the only provenance signal
 * Clubworx offers (#47: one key per gym, so attribution by key is impossible) —
 * it is what lets an operator resolving a duplicate see which school the other
 * record belongs to. `status` is what the row calls itself.
 *
 * A phone number and a home address answer no question asked here, so they do
 * not leave the Worker.
 */
function projectContact(row, view) {
  return {
    contact_key: row.contact_key,
    first_name: row.first_name ?? null,
    last_name: row.last_name ?? null,
    // Passed through exactly as Clubworx sent it, blank included. #49 measured
    // that a hand-created contact can carry no DOB, and identity.js has a
    // `candidate-dob-unknown` state for that row. Normalising it away here would
    // hide the one candidate most likely to become a duplicate.
    dob: row.dob ?? null,
    email: row.email ?? null,
    status: row.status ?? null,
    // Which of the three held them. Not needed to match — a contact is in
    // exactly one view — but it is the fact that explains a surprise, and it is
    // free.
    status_view: view,
  };
}

const failure = ({ reason, message, view, upstreamStatus = null, requests }) => ({
  ok: false,
  reason,
  message,
  view,
  upstreamStatus,
  candidates: [],
  requests,
});

/**
 * Search all three status views for one student and merge the results.
 *
 * @param {object} opts
 * @param {{get: (path: string, params: object) => Promise<object>}} opts.client
 *   A `createClubworxClient` instance. Everything it sends is paced.
 * @param {string} opts.lastName  Surname, as the operator's paste spelled it.
 * @param {string} opts.dob       `YYYY-MM-DD`.
 * @returns {Promise<{ok: true, candidates: object[], views: object[], requests: number}
 *                 | {ok: false, reason: string, message: string|null, view: string,
 *                    upstreamStatus: number|null, candidates: [], requests: number}>}
 */
export async function searchContacts({ client, lastName, dob }) {
  // Keyed by contact_key, so a contact seen in two views — or twice across a
  // shifting page boundary — merges instead of duplicating. First sighting wins:
  // the views are disjoint, so a second one is a race, not new information.
  const byKey = new Map();
  const views = [];
  let requests = 0;

  for (const view of CONTACT_VIEWS) {
    let pages = 0;
    let rowsSeen = 0;

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const res = await client.get(view, {
        last_name: lastName,
        dob,
        page,
        page_size: PAGE_SIZE,
      });
      requests += 1;
      pages += 1;

      if (!res.ok) {
        // A throttle is told apart from everything else because it is the one
        // failure the page answers differently: §11 pauses the whole run, and
        // says out loud that the cause may be another system on the same
        // gym-wide key.
        return failure({
          reason: res.status === 429 ? 'throttled' : 'upstream-error',
          // `message` is the client's own contract: it runs `errorMessageOf`
          // over every JSON body and puts the scrubbed reason there on a
          // connection failure. `bodyText` is the leftover case — a throttle or
          // a WAF block answering in HTML, already redacted and truncated.
          message: res.message ?? res.bodyText ?? null,
          view,
          upstreamStatus: res.status,
          requests,
        });
      }

      // Measured: these endpoints answer with a bare array (#49, #60). Anything
      // else is a response nobody here has seen, and reading it as "no rows" is
      // the single wrong guess that ends in a permanent duplicate contact.
      if (!Array.isArray(res.body)) {
        return failure({
          reason: 'upstream-error',
          message: `${view} answered ${res.status} with a body that is not a list of contacts`,
          view,
          upstreamStatus: res.status,
          requests,
        });
      }

      for (const row of res.body) {
        // A row with no key cannot be booked, cannot be given a pass, and would
        // merge every other keyless row into one under `undefined`.
        if (!row?.contact_key) continue;
        if (!byKey.has(row.contact_key)) byKey.set(row.contact_key, projectContact(row, view));
      }
      rowsSeen += res.body.length;

      // A short page is the end of the list — the only end-of-list signal there
      // is, since #51 confirmed no total and no next-page link come back. A page
      // that is exactly full is ambiguous, so it costs one more request to find
      // out; that is the price of not silently truncating.
      if (res.body.length < PAGE_SIZE) break;

      if (page === MAX_PAGES) {
        // Still full at the ceiling: the query did not narrow. See MAX_PAGES.
        return failure({
          reason: 'search-not-narrowed',
          message:
            `${view} was still returning a full page of ${PAGE_SIZE} at page ${MAX_PAGES} — ` +
            'the surname and date of birth did not narrow the search, so this answer ' +
            'cannot be told apart from a sweep of the whole contact database',
          view,
          upstreamStatus: res.status,
          requests,
        });
      }
    }

    views.push({ view, pages, rows: rowsSeen });
  }

  return { ok: true, candidates: [...byKey.values()], views, requests };
}
