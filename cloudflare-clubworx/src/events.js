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
 * does, the picker returns 422 for every staff member at once. `resolveEvent`
 * below is why that would be an inconvenience rather than an outage.
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
import { isRetryable, upstreamMessage, upstreamReason } from './upstream.js';

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
 * Never the default 50 — #51 measured that default as exactly the trap this
 * module guards. 200 is verified to work on this endpoint.
 */
export const PAGE_SIZE = 200;

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

  const byStart = (a, b) => String(a.event_start_at).localeCompare(String(b.event_start_at));
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

const byStart = (a, b) => String(a.event_start_at).localeCompare(String(b.event_start_at));

const failure = ({ reason, message, upstreamStatus = null, requests }) => ({
  ok: false,
  reason,
  message,
  upstreamStatus,
  events: [],
  requests,
});

/**
 * Walk one date window to exhaustion, collecting raw rows.
 *
 * @returns {Promise<{ok: true, rows: object[], pages: number, requests: number, truncated: boolean}
 *                 | {ok: false, reason: string, message: string|null, upstreamStatus: number|null,
 *                    events: [], requests: number}>}
 */
async function walkWindow({ client, from, to, startedRequests = 0 }) {
  const rows = [];
  let requests = startedRequests;
  let pages = 0;
  let truncated = false;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const res = await client.get('events', {
      event_starts_after: from,
      event_ends_before: to,
      page,
      page_size: PAGE_SIZE,
    });
    requests += 1;
    pages += 1;

    if (!res.ok) {
      // A throttle travels as itself: §11 pauses the *whole run* on one, because
      // the allowance is gym-wide (#47) and backing off one read while the rest
      // continue just spends the next window failing.
      return failure({
        reason: upstreamReason(res),
        message: upstreamMessage(res),
        upstreamStatus: res.status,
        requests,
      });
    }

    // Measured: this endpoint answers with a bare array (#51). Reading anything
    // else as "no events" would show an empty picker for a term that is full.
    if (!Array.isArray(res.body)) {
      return failure({
        reason: 'upstream-error',
        message: `events answered ${res.status} with a body that is not a list of events`,
        upstreamStatus: res.status,
        requests,
      });
    }

    rows.push(...res.body);

    // A short page is the end of the list — the only end-of-list signal there
    // is. A page that is exactly full is ambiguous, so it costs one more request
    // to find out; that is the price of not silently truncating.
    if (res.body.length < PAGE_SIZE) break;
    if (page === MAX_PAGES) truncated = true;
  }

  return { ok: true, rows, pages, requests, truncated };
}

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
 * @param {string} opts.from `YYYY-MM-DD`, inclusive — `event_starts_after`.
 * @param {string} opts.to `YYYY-MM-DD`, inclusive — `event_ends_before`.
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
 * **This is the path that cannot break** (#51, recorded as a hard requirement on
 * #54). The picker is built entirely on an undocumented behaviour that
 * contradicts Clubworx's own reference; this fallback survives the listing being
 * wrong, the window being wrong, the event falling outside whatever range the
 * picker offers, and Clubworx deciding to enforce what its docs say. It is a
 * shortcut past the *search*, never past the *confirmation* — the name, the date
 * and `spaces_available` come back so a human agrees it is the right class.
 *
 * Two paths, in order, because **`GET /events/:id` is unmeasured**. Every probe
 * so far has read the collection; path-addressing exists in this API
 * (`DELETE /bookings/:id`, measured in #60) but has never been exercised here.
 * So the direct call is tried, and a **non-retryable** refusal is read as "that
 * is not a route" and falls back to walking the window — which is measured, and
 * is what makes this useful today whichever way the direct call turns out.
 *
 * A retryable failure — a throttle, a 5xx, a dropped connection — travels as
 * itself instead. Those are upstream trouble, not a missing route, and spending
 * a second walk on one would only deepen a throttle §11 wants the page to pause
 * the whole run on.
 *
 * @param {object} opts
 * @param {{get: (path: string, params: object) => Promise<object>}} opts.client
 * @param {string} opts.eventId The id exactly as it was pasted.
 * @param {string} [opts.from] `YYYY-MM-DD` — the window to fall back to, if any.
 * @param {string} [opts.to] `YYYY-MM-DD`.
 * @param {string} [opts.now]
 */
export async function resolveEvent({ client, eventId, from = '', to = '', now = new Date().toISOString() }) {
  const wanted = String(eventId ?? '').trim();
  if (!wanted) {
    return failure({ reason: 'bad-request', message: 'event_id is required', requests: 0 });
  }

  // Encoded into the path, because `buildUrl` interpolates `path` verbatim — an
  // id carrying a `/` or a `?` would otherwise rewrite the request.
  const direct = await client.get(`events/${encodeURIComponent(wanted)}`);
  let requests = 1;

  if (!direct.ok && isRetryable(direct)) {
    return failure({
      reason: upstreamReason(direct),
      message: upstreamMessage(direct),
      upstreamStatus: direct.status,
      requests,
    });
  }

  // One event, and it has to be the one that was asked for. If `events/:id` is
  // not a route, Clubworx may well answer with the collection instead — taking
  // row one out of that would put the wrong class in front of an operator to
  // confirm, which is the single failure this fallback exists to prevent.
  const candidates = Array.isArray(direct.body)
    ? direct.body
    : direct.body && typeof direct.body === 'object'
      ? [direct.body]
      : [];
  const hit = candidates.length === 1 && String(candidates[0]?.event_id) === wanted ? candidates[0] : null;

  if (hit) {
    return { ok: true, event: projectEvent(hit, now), via: 'direct', requests };
  }

  if (isRealDay(from) && isRealDay(to) && from <= to) {
    const walk = await walkWindow({ client, from, to, startedRequests: requests });
    if (!walk.ok) return walk;
    requests = walk.requests;

    const found = walk.rows.find(row => String(row?.event_id) === wanted);
    if (found) return { ok: true, event: projectEvent(found, now), via: 'window', requests };
  }

  return failure({
    reason: 'event-not-found',
    message: `Clubworx did not resolve event id "${wanted}"`,
    upstreamStatus: direct.status ?? null,
    requests,
  });
}
