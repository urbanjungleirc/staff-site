/**
 * The event picker's read: what is on at the gym, and which sessions are bookable.
 *
 * staff-site#67. Design: `docs/superpowers/specs/2026-08-19-school-group-booking-design.md`
 * §8 (event selection), §11 (the lead-time hard-stop), §13.
 *
 * ---------------------------------------------------------------------------
 * Why a gym-wide event list is possible at all
 * ---------------------------------------------------------------------------
 * `GET /events` documents `contact_key` as **required**. It is not — #51
 * measured that the parameter is ignored entirely: omitted, blank, arbitrary and
 * a real member's key all return the identical gym-wide set. That is what
 * unblocks a picker that can show an event **nobody has booked into yet**, which
 * the HVT Worker's derive-from-bookings trick could never do.
 *
 * It is also **undocumented and contradicts the published reference**, so
 * nothing stops Clubworx from enforcing what its own docs say — and the day it
 * does, the picker returns 422 for every staff member at once. Nothing in this
 * module survives that: `resolveEvent` reads the same endpoint. See its header.
 *
 * ---------------------------------------------------------------------------
 * Three measured traps
 * ---------------------------------------------------------------------------
 * **The date window is required.** Dropping both date parameters is a `422` with
 * an empty body, not "everything" (#51). So the window is validated here rather
 * than met as an upstream refusal an operator cannot act on.
 *
 * **A full page is silent truncation.** Every #51 variant returned exactly 50 —
 * the default `page_size` — where a three-month window holds more. There is no
 * total, no next-page link and no header, so a truncated page is
 * indistinguishable from a complete list by anything in the response. A staff
 * member opening "events this term" and seeing 50 rows has no way to know the
 * session they want is on page 2, and neither has the page unless it counts. So
 * this pages to exhaustion and, when it cannot, **says so** — §8's *"list
 * truncated — narrow by hand"*.
 *
 * **`spaces_available` has been wrong in both directions** (#50). It travels
 * because a school group of 30 into an event with 12 spaces is a failure the
 * page can predict before booking anything — but §11 makes it a warning, never a
 * block.
 *
 * ---------------------------------------------------------------------------
 * This route annotates; it does not filter
 * ---------------------------------------------------------------------------
 * Every event in the window comes back, each carrying its lead time and a
 * `bookable` verdict. Dropping the unbookable ones would be the same silent
 * adjustment D9 rejected for the lead time: a session missing from the picker is
 * invisible and unexplained, where a session shown greyed out with its reason
 * beside it is a decision a human can make.
 *
 * `pickBookableEvents` is the exception, and it is the probes' selector rather
 * than this route's — a probe needs *one safe event to write to*, so filtering
 * is the whole job there.
 */

import { isRealDay } from './duration.js';
import { PAGE_SIZE, pageThrough } from './paging.js';
import { upstreamMessage, upstreamReason } from './upstream.js';

/**
 * UJ's School Sessions refuse a booking made inside a day of the start. The rule
 * lives in Clubworx's configuration and no endpoint exposes it, so it is
 * pre-empted rather than met as Clubworx's own message — *"Sorry! This class is
 * now closed for bookings."* — which names no cause and reads like a capacity
 * problem (D9).
 *
 * The one definition. `student.js` imports it from here so the picker's grey-out
 * and the write chain's hard-stop can never disagree about which sessions are
 * too soon — a drift that would show up as a run refused at the last step for a
 * session the page had shown as selectable.
 */
export const MIN_LEAD_HOURS = 24;

/**
 * Re-exported so the page-size guarantee this route depends on is assertable
 * here, beside the #51 measurement that makes it load-bearing.
 */
export { PAGE_SIZE };

/**
 * How far a window may be walked before the listing is called truncated.
 *
 * 2,000 events is far past any window a picker should be asking for — the tool
 * wants this week or this term, not a quarter — so reaching this means the
 * window is too wide, and the answer says so rather than growing without bound
 * against a 75-requests-a-minute allowance that the whole gym shares.
 */
export const MAX_PAGES = 10;

/**
 * How long until an event starts, and whether the lead-time rule would allow it.
 *
 * Promoted from `probes/lib/report.mjs` (#67); the probes import it from here
 * now, so there is one definition.
 *
 * @param {string} eventStartAt ISO timestamp, with offset.
 * @param {{now?: string, minLeadHours?: number}} [opts]
 */
export function describeLeadTime(
  eventStartAt,
  { now = new Date().toISOString(), minLeadHours = MIN_LEAD_HOURS } = {},
) {
  const starts = Date.parse(eventStartAt);
  const from = Date.parse(now);

  if (Number.isNaN(starts) || Number.isNaN(from)) {
    return { hoursAhead: null, withinLeadTime: null, past: null, minLeadHours, unreadable: true };
  }

  const hoursAhead = (starts - from) / 3_600_000;

  return {
    hoursAhead: Math.round(hoursAhead * 10) / 10,
    past: hoursAhead <= 0,
    // "Within the lead time" means too close to book, not comfortably ahead.
    withinLeadTime: hoursAhead > 0 && hoursAhead < minLeadHours,
    minLeadHours,
    unreadable: false,
  };
}

/** Timetable order. Clubworx timestamps are ISO with an offset, so they sort as strings. */
const byStart = (a, b) => String(a.event_start_at).localeCompare(String(b.event_start_at));

/**
 * Which events a **probe** may safely be booked into.
 *
 * Promoted from `probes/lib/report.mjs` (#67) unchanged. A booking is a real row
 * on a real class that staff see, so a probe's event must be in the future and
 * must have room — consuming the last space would cause #46's own worst case, a
 * school group arriving at an event with fewer spaces than students. Free and
 * paid come back separately because #50's second question needed the comparison.
 *
 * Not what the picker uses. See the header: this route annotates rather than
 * filtering, because an event dropped from a picker is an event nobody can ask
 * about.
 *
 * @param {unknown} body A `GET /events` response.
 * @param {{now?: string}} [opts]
 */
export function pickBookableEvents(body, { now = new Date().toISOString() } = {}) {
  if (!Array.isArray(body)) return { free: [], paid: [], skipped: 0 };

  const free = [];
  const paid = [];
  let skipped = 0;

  for (const row of body) {
    const starts = row?.event_start_at ?? null;
    const roomy = row?.event_full !== true && (row?.spaces_available ?? 0) > 0;

    if (!starts || starts <= now || !roomy) {
      skipped += 1;
      continue;
    }

    // The name travels because a human has to recognise the class they are
    // about to put a test booking on. An event name is a timetable entry —
    // nothing here describes a person.
    const event = {
      event_id: row.event_id,
      event_name: row.event_name ?? null,
      event_start_at: starts,
      spaces_available: row.spaces_available ?? null,
      free_class: row.free_class === true,
    };

    (event.free_class ? free : paid).push(event);
  }

  return { free: free.sort(byStart), paid: paid.sort(byStart), skipped };
}

/**
 * The fields an event travels with, and nothing else.
 *
 * `location_id`/`location_name` are here because §8 pre-ticks *same-name,
 * same-location* events ahead of the one staff picked — location is half of that
 * rule, not decoration. `instructor_name` is a staff member and `event_description`
 * is free text; neither answers a question the picker asks, so neither leaves
 * the Worker.
 */
function projectEvent(row, now) {
  const lead = describeLeadTime(row.event_start_at, { now });
  const hasRoom = row.event_full !== true && (row.spaces_available ?? 0) > 0;

  return {
    event_id: row.event_id,
    event_name: row.event_name ?? null,
    event_start_at: row.event_start_at ?? null,
    event_end_at: row.event_end_at ?? null,
    location_id: row.location_id ?? null,
    location_name: row.location_name ?? null,
    free_class: row.free_class === true,
    event_full: row.event_full === true,
    // Passed through exactly as Clubworx sent it, including a null. #50 measured
    // that this number does not predict a refusal, so smoothing a missing one to
    // 0 would invent a certainty that is not there.
    spaces_available: row.spaces_available ?? null,
    lead,
    // Everything the page needs to grey a row out, with `lead` beside it saying
    // which of the reasons applied. Never a reason to hide the row.
    bookable: lead.unreadable === false && lead.past === false && lead.withinLeadTime === false && hasRoom,
  };
}

const failure = ({ reason, message, upstreamStatus = null, requests }) => ({
  ok: false,
  reason,
  message,
  upstreamStatus,
  events: [],
  requests,
});

/** Walk one date window to exhaustion. The window parameters are the measured ones (#51). */
const walkWindow = ({ client, from, to }) =>
  pageThrough({
    client,
    path: 'events',
    params: { event_starts_after: from, event_ends_before: to },
    maxPages: MAX_PAGES,
    what: 'events',
  });

/**
 * Validate the window before spending a request on it.
 *
 * Both dates or neither is not the choice — #51 measured that omitting them is a
 * 422 with an empty body, so "neither" is never an answer. `isRealDay` is the
 * same check the contact routes use: `2026-02-30` does not throw, it rolls
 * forward, and a window silently shifted by a day is a session missing from a
 * picker with nothing on screen to explain it.
 */
function windowProblem(from, to) {
  if (!isRealDay(from) || !isRealDay(to)) {
    return 'from and to are required, each as a real YYYY-MM-DD day';
  }
  if (from > to) return 'the date window runs backwards — from must not be after to';
  return null;
}

/**
 * List every event in a date window, paged to exhaustion.
 *
 * @param {object} opts
 * @param {{get: (path: string, params: object) => Promise<object>}} opts.client
 *   A `createClubworxClient` instance. Everything it sends is paced.
 * @param {string} opts.from `YYYY-MM-DD` — sent as `event_starts_after`.
 * @param {string} opts.to `YYYY-MM-DD` — sent as `event_ends_before`. Whether the
 *   boundary day itself is included is Clubworx's to decide and is **unmeasured**
 *   — #51 exercised the window's presence, not its edges. Both dates are passed
 *   through untouched rather than nudged a day to compensate for a rule nobody
 *   has checked: a caller wanting the last day of term certainly in range should
 *   ask for the day after it.
 * @param {string} [opts.q] A name fragment, matched **here** rather than upstream.
 * @param {string} [opts.now] The instant of the run. Injected so tests are not clock-dependent.
 */
export async function listEvents({ client, from, to, q = '', now = new Date().toISOString() }) {
  const problem = windowProblem(from, to);
  if (problem) {
    return failure({ reason: 'bad-request', message: problem, requests: 0 });
  }

  const walk = await walkWindow({ client, from, to });
  if (!walk.ok) return walk;

  const events = walk.rows
    // A row with no id cannot be booked and cannot be confirmed, so showing it
    // would offer staff a session they cannot select.
    .filter(row => row?.event_id !== null && row?.event_id !== undefined)
    .map(row => projectEvent(row, now))
    .sort(byStart);

  // The name filter runs here, not upstream. **No name parameter is measured on
  // `/events`** — #51 exercised `contact_key`, the date window and paging, and
  // nothing else — so sending an invented one risks a filter Clubworx quietly
  // ignores (which is harmless) or quietly honours differently (which returns
  // less than the window holds and looks exactly like a thin timetable). The
  // window is already narrow by design, so filtering the walked rows costs one
  // pass over an array.
  const needle = String(q ?? '').trim().toLowerCase();
  const matched = needle
    ? events.filter(e => String(e.event_name ?? '').toLowerCase().includes(needle))
    : events;

  return {
    ok: true,
    events: matched,
    // Before the name filter, so a picker showing 2 of 60 can say which it is.
    total: events.length,
    truncated: walk.truncated,
    pages: walk.pages,
    requests: walk.requests,
    window: { from, to },
    q: q ?? '',
  };
}

/**
 * Resolve one pasted Clubworx event id.
 *
 * The paste field is a hard requirement on #54, and #51 is why: the picker is
 * built entirely on an **undocumented** behaviour that contradicts Clubworx's
 * own reference. A pasted id is a shortcut past the *search*, never past the
 * *confirmation* — the name, the date and `spaces_available` come back so a
 * human agrees it is the right class before it can be selected.
 *
 * ---------------------------------------------------------------------------
 * What this does and does not survive — stated precisely, because the loose
 * version of this sentence was wrong
 * ---------------------------------------------------------------------------
 * It survives the **search** being unhelpful: a name `?q=` filtered out, a
 * window that truncated, a timetable too long to scan.
 *
 * It does **not** survive Clubworx enforcing the `contact_key` its reference
 * documents. That would take `/events` down as a whole, and this route is on the
 * same endpoint — there is no path here that outlives its own API. Claiming
 * otherwise (an earlier draft of this header did) would have made a real outage
 * look like a covered case.
 *
 * ---------------------------------------------------------------------------
 * One request, and `GET /events/:id` is unmeasured
 * ---------------------------------------------------------------------------
 * Every probe so far has read the collection. Path addressing exists in this API
 * — `DELETE /bookings/:id` was measured in #60 — but `events/:id` has never been
 * exercised, so **whether this route works at all against production is an open
 * question a probe should close** (noted on #67).
 *
 * An earlier draft fell back to re-walking `from`/`to` when the direct call
 * failed. That was dropped: it spends up to `MAX_PAGES` requests of a gym-wide
 * 75/min allowance to find an id that, being inside the window, the page already
 * has on screen from the listing it just made. #67 asks for the id resolved
 * *directly*; the window is the page's own to search.
 *
 * @param {object} opts
 * @param {{get: (path: string, params: object) => Promise<object>}} opts.client
 * @param {string} opts.eventId The id exactly as it was pasted.
 * @param {string} [opts.now]
 */
export async function resolveEvent({ client, eventId, now = new Date().toISOString() }) {
  const wanted = String(eventId ?? '').trim();
  if (!wanted) {
    return failure({ reason: 'bad-request', message: 'event_id is required', requests: 0 });
  }

  // Encoded into the path, because `buildUrl` interpolates `path` verbatim — an
  // id carrying a `/` or a `?` would otherwise rewrite the request.
  const res = await client.get(`events/${encodeURIComponent(wanted)}`);
  const requests = 1;

  if (!res.ok) {
    return failure({
      reason: upstreamReason(res),
      message: upstreamMessage(res),
      upstreamStatus: res.status,
      requests,
    });
  }

  // One event, and it has to be the one that was asked for. If `events/:id` is
  // not a route, Clubworx may well answer with the collection instead — taking
  // row one out of that would put the wrong class in front of an operator to
  // confirm, which is the single failure this route exists to prevent.
  const candidates = Array.isArray(res.body)
    ? res.body
    : res.body && typeof res.body === 'object'
      ? [res.body]
      : [];
  const hit = candidates.length === 1 && String(candidates[0]?.event_id) === wanted ? candidates[0] : null;

  if (hit) return { ok: true, event: projectEvent(hit, now), requests };

  return failure({
    reason: 'event-not-found',
    message: `Clubworx did not resolve event id "${wanted}"`,
    upstreamStatus: res.status ?? null,
    requests,
  });
}
