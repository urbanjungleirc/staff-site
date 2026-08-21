/**
 * The school picker's read: which **School markers** Clubworx already holds.
 *
 * staff-site#67. Design: `docs/superpowers/specs/2026-08-19-school-group-booking-design.md`
 * §4 (school marking) and §6 (the route table). Glossary: `CONTEXT.md` §School
 * marker — the whole address is the *marker*, and `<school>` inside it is the
 * *tag*. Both terms are used here in exactly those senses; "slug" is a synonym
 * this module deliberately does not use.
 *
 * ---------------------------------------------------------------------------
 * Why this list matters more than a picker usually would
 * ---------------------------------------------------------------------------
 * Every contact this tool creates is written with the email
 * `noreply+<school>@urbanjungleirc.com`. One field carrying three things: a
 * marker that this is a school-import contact, a record of *which* school, and a
 * search key — Clubworx's email filter partial-matches, so `noreply%2B` finds
 * every contact the tool has ever created and a full tag isolates one school's
 * (#49, measured).
 *
 * **It is the only provenance this system will ever have.** Clubworx issues one
 * key per gym (#47), so attribution by key is impossible, and there is no field
 * that says "the school tool wrote this". Months later, the tag is the entire
 * reason an operator resolving a duplicate can tell which school the other
 * record belongs to.
 *
 * So the cost of a tag missing from this list is not a thin picker. It is a
 * staff member typing `newmanjhs` beside an existing `newman` — permanently, on
 * contacts Clubworx cannot delete (ACCESS.md §4), splitting one school's history
 * into two tags that nothing will ever reconcile. That is why this searches all
 * three status views and pages, rather than reading the default page of one.
 *
 * ---------------------------------------------------------------------------
 * It returns tags, not contacts
 * ---------------------------------------------------------------------------
 * The rows behind this answer are hundreds of real children — the whole point of
 * the `noreply%2B` partial is that it matches every one of them. Only the tag,
 * the address to write, and a count leave the Worker. The Worker is a transit,
 * not a database (§6, D10), and a picker needs a list of schools, not a list of
 * students.
 *
 * The **count earns its place** rather than being a diagnostic: a near-duplicate
 * tag is what this list exists to prevent, and `newman 63` beside `newmanjhs 2`
 * is how an operator recognises the second as somebody's typo. Without it the two
 * read as equally real schools.
 *
 * ---------------------------------------------------------------------------
 * The tag is chosen by staff, never derived here
 * ---------------------------------------------------------------------------
 * This route surfaces what exists so staff can *reuse* a tag rather than invent
 * a second spelling of one. Picking a new tag is still a human decision (§4);
 * deriving one from the least reliable line in a pasted document is the trade
 * that was rejected.
 */

import { CONTACT_VIEWS } from './contacts.js';
import { PAGE_SIZE, pageThrough } from './paging.js';

/**
 * The partial that matches every contact this tool has created.
 *
 * Sent as `email=noreply+`; `URLSearchParams` encodes it to `noreply%2B`, which
 * is the exact form #49 measured returning 3 of 3 tagged contacts. Clubworx's
 * email filter is a prefix/partial match, so this acts as "every school-created
 * contact" and a full tag isolates one school's.
 */
export const SCHOOL_EMAIL_PREFIX = 'noreply+';

/** Re-exported so this route's page size is assertable beside the trap it guards. */
export { PAGE_SIZE };

/**
 * How far one view may be walked before the tag list is called incomplete.
 *
 * Unlike `contacts.js`'s ceiling of 3, this query is *meant* to match broadly —
 * `noreply+` is every contact the tool has ever created, and #48 found a single
 * school list of 63 students. Ten pages is 2,000 contacts per view: years of
 * school imports, and 30 requests at worst across the three views, which is
 * roughly 24 seconds of the gym-wide allowance (#51). Reaching it is reported as
 * a truncation, not swallowed.
 */
export const MAX_PAGES = 10;

/**
 * The tag out of a plus-addressed `noreply` address, or null.
 *
 * Domain-agnostic on purpose. `urbanjungleirc.com` is what the tool writes
 * today, but the domain is not this module's to assert — and matching on it
 * would drop a school's whole history the day the address changes, which is
 * precisely the kind of silent loss the tag exists to prevent.
 *
 * The tag is lowercased because two spellings of one school are the duplicate
 * this list exists to prevent, and Clubworx stores the address exactly as it was
 * written (#49) — including its case.
 *
 * @param {unknown} email
 * @returns {string|null}
 */
export function schoolTagOf(email) {
  if (typeof email !== 'string') return null;
  const match = /^noreply\+([^@\s]+)@/i.exec(email.trim());
  return match ? match[1].toLowerCase() : null;
}

const failure = ({ reason, message, view, upstreamStatus = null, requests }) => ({
  ok: false,
  reason,
  message,
  view,
  upstreamStatus,
  schools: [],
  requests,
});

/**
 * Every distinct school tag in Clubworx, across all three status views.
 *
 * @param {object} opts
 * @param {{get: (path: string, params: object) => Promise<object>}} opts.client
 *   A `createClubworxClient` instance. Everything it sends is paced.
 * @returns {Promise<{ok: true, schools: Array<{tag: string, email: string, contacts: number}>,
 *                    truncated: boolean, views: object[], requests: number}
 *                 | {ok: false, reason: string, message: string|null, view: string,
 *                    upstreamStatus: number|null, schools: [], requests: number}>}
 */
export async function listSchools({ client }) {
  /** tag -> {tag, email, keys} — keys is a Set so a contact seen twice counts once. */
  const byTag = new Map();
  const views = [];
  let requests = 0;
  let truncated = false;

  for (const view of CONTACT_VIEWS) {
    const walk = await pageThrough({
      client,
      path: view,
      params: { email: SCHOOL_EMAIL_PREFIX },
      maxPages: MAX_PAGES,
      what: 'contacts',
      requests,
    });

    if (!walk.ok) {
      // The view that failed travels with the refusal, because "which schools am
      // I missing" is the question an operator will have — and a throttle is
      // told apart from everything else, since §11 pauses the whole run on one.
      return failure({ ...walk, view });
    }

    requests = walk.requests;
    if (walk.truncated) truncated = true;

    walk.rows.forEach((row, position) => {
      const tag = schoolTagOf(row?.email);
      if (!tag) return;

      if (!byTag.has(tag)) {
        // The address exactly as Clubworx holds it, so the write reuses the
        // domain already in use rather than the page guessing at one.
        byTag.set(tag, { tag, email: String(row.email).trim(), keys: new Set() });
      }
      // A contact with no key still evidences the tag but cannot be deduped
      // against — count it under its own identity rather than merging every
      // keyless row into one.
      byTag.get(tag).keys.add(row?.contact_key ?? `row-${view}-${position}`);
    });

    views.push({ view, pages: walk.pages, rows: walk.rows.length });
  }

  const schools = [...byTag.values()]
    .map(({ tag, email, keys }) => ({ tag, email, contacts: keys.size }))
    .sort((a, b) => a.tag.localeCompare(b.tag));

  return {
    ok: true,
    schools,
    // Not a refusal. Staff can always type a tag by hand, and a picker that
    // refused outright would block a school that is simply further down the
    // list — but the page must be able to say the list is partial rather than
    // presenting it as every school there is.
    truncated,
    views,
    requests,
  };
}
