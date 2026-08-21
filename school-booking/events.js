// school-booking/events.js
//
// Step 4 — what a *selection of sessions* is, as a pure module. The page
// imports this and publishes it as `window.schoolBookingEvents`, the same seam
// parse.js and steps.js already use.
//
// staff-site#72. Design: `docs/superpowers/specs/2026-08-19-school-group-booking-design.md`
// §8 (event selection) and §11 (the hard-stops).
//
// ---------------------------------------------------------------------------
// The division of labour with the Worker
// ---------------------------------------------------------------------------
// `cloudflare-clubworx/src/events.js` decides what an **event** is: it walks the
// date window to exhaustion, annotates each row with its lead time and answers
// a `bookable` verdict. It deliberately does not filter — §8 — because a
// session missing from a picker is invisible and unexplained.
//
// This module decides what a **selection** is: which sessions arrive pre-ticked,
// what a pasted id resolves to, and what stops the run. Nothing here re-derives
// a lead time; `lead` and `bookable` are read as given, so the picker's grey-out
// and the write chain's refusal can never disagree.
//
// ---------------------------------------------------------------------------
// The pasted id is resolved here, and that is a change of plan
// ---------------------------------------------------------------------------
// §8 asks for an event-ID fallback and #67 built one on `GET /events/:id`. #97
// then measured that route against production: it answers **404 for every id**,
// real or invented, with or without a date window. The Worker route survives
// only as an honest refusal — every call is a 502 carrying Clubworx's own
// `"Not Found"`, which reads to staff as *this id does not exist* when the truth
// is *this endpoint does not exist*. Putting that in front of the front desk
// would make a working id look like a typo.
//
// So the fallback resolves **page-side**, against the window the picker has
// already walked — the option `cloudflare-clubworx/src/events.js` hands to #54
// at the end of its `resolveEvent` header, and the cheaper one either way: an id
// inside the window is already on screen, and re-walking to find it would spend
// up to ten requests of a gym-wide 75-a-minute allowance on a lookup that costs
// nothing here.
//
// What it therefore cannot do is find an event **outside** the window. That is
// why `resolvePastedId` says *not in this window* and never *not found*: the two
// are different problems with different fixes — widen the window, or check the
// id — and the second sends staff to correct something that is already correct.

// The picker's opening window — a fortnight, and deliberately not a term.
//
// Nothing loads until the operator presses Search, so this is a *starting
// point* they widen to the last session, not a guess at the run. It is short
// because the cheap thing has to be the default one: a term-wide window is
// ~900 events at this gym, five requests of a gym-wide allowance and a table
// nobody can scan, and a default that expensive is one an operator pays for
// every time they arrive at this step without meaning to.
//
// Narrowing the dates is also the *only* lever on that cost. The name filter
// runs in the Worker's memory after the window has been walked (listEvents, and
// the paragraph there explains why it is not sent upstream), so it shortens the
// table and never the request count.
const WINDOW_DAYS = 14;

// Everything this system does is in Perth, so the run day is the Perth day.
// Same constant and the same reasoning as `cloudflare-clubworx/src/duration.js`;
// this file cannot import that one — it runs in the browser, and that module
// ships with the Worker.
const AWST_OFFSET_MS = 8 * 60 * 60 * 1000;

const plural = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** Timetable order. Clubworx timestamps are ISO with an offset, so they sort as strings. */
const byStart = (a, b) => String(a.event_start_at).localeCompare(String(b.event_start_at));

/** The calendar day an instant falls on **in Perth**, or null if it cannot be read. */
function perthDay(instant) {
  const at = new Date(instant);
  if (Number.isNaN(at.getTime())) return null;
  return new Date(at.getTime() + AWST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * The date window the picker opens with: today in Perth, and a term ahead.
 *
 * The Perth day rather than the UTC one is load-bearing for eight hours of every
 * day. Between midnight and 08:00 AWST the UTC date is still yesterday, so a
 * window opened on it starts a day early — harmless — while an *end* computed
 * from it stops a day early, and a window opened on the UTC day by a page whose
 * events are all stamped +08:00 leaves this morning's sessions out of the list
 * at exactly the hour someone is setting up a morning school group.
 *
 * @param {string|Date} [now] The instant of the run. Injected so the picker's
 *   window is testable without a clock.
 * @returns {{from: string, to: string}} `YYYY-MM-DD` days, or two empty strings
 *   when the instant could not be read — the Worker refuses a window that is not
 *   two real days (#51), and inventing one here would send it a window nobody
 *   chose.
 */
export function defaultWindow(now = new Date()) {
  const from = perthDay(now);
  if (!from) return { from: '', to: '' };

  const end = new Date(`${from}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + WINDOW_DAYS);
  return { from, to: end.toISOString().slice(0, 10) };
}

/**
 * Two events are the same series when their names and locations match.
 *
 * There is **no series or recurrence field in the API** (§8), so this is the
 * whole of what "the same weekly class" can mean here. Names are compared on
 * their trimmed, case-folded form because a school's sessions are created by
 * hand, one a week, and `School Session — Newman` acquires a stray space or a
 * lower-case s somewhere in a term.
 *
 * A nameless event matches nothing but itself. Two events with no name are not
 * evidence of a series — they are two rows nobody filled in — and grouping them
 * would pre-tick an unrelated class on the strength of a missing field.
 */
const seriesKey = (event) => {
  const name = String(event?.event_name ?? '').trim().toLowerCase();
  if (!name) return null;
  return `${name}@@${event?.location_id ?? ''}`;
};

/**
 * The sessions that arrive ticked when staff pick one.
 *
 * §8: staff pick the **first** session, and same-name, same-location events
 * **ahead of it** arrive pre-ticked and correctable. Ahead of it, not around it:
 * ticking the sessions behind the anchor would book a group into classes that
 * have already run, and the anchor is the first session precisely so that the
 * rest of the term follows from one click.
 *
 * An unbookable session ahead of the anchor is still ticked. It is part of the
 * series, and §8 annotates rather than filters — a too-soon session arriving
 * unticked looks like a session that is not in the series at all, where a ticked
 * one carries its own reason and D9's one-click removal.
 *
 * @param {Array<object>} events The window, as the Worker projected it.
 * @param {string|number|null} anchorId The session staff clicked.
 * @returns {Array<string>} Event ids, in timetable order, the anchor included.
 */
export function preTicked(events, anchorId) {
  const list = Array.isArray(events) ? events : [];
  const wanted = anchorId === null || anchorId === undefined ? '' : String(anchorId);
  const anchor = list.find((e) => String(e?.event_id) === wanted);
  if (!anchor) return [];

  const key = seriesKey(anchor);
  if (key === null) return [String(anchor.event_id)];

  return list
    .filter((e) => seriesKey(e) === key && String(e.event_start_at) >= String(anchor.event_start_at))
    .sort(byStart)
    .map((e) => String(e.event_id));
}

/**
 * Resolve a pasted Clubworx event id against the window already on screen.
 *
 * See the header for why this is page-side. The three failures are told apart
 * because they send staff to three different places: an empty box, a picker that
 * has not loaded, and an id the window does not reach.
 *
 * @param {Array<object>} events The loaded window.
 * @param {string} pasted The id exactly as it was pasted.
 */
export function resolvePastedId(events, pasted) {
  const wanted = String(pasted ?? '').trim();
  if (!wanted) {
    return { ok: false, reason: 'no-id', message: 'Paste a Clubworx event id first.', event: null };
  }

  const list = Array.isArray(events) ? events : [];
  if (list.length === 0) {
    return {
      ok: false,
      reason: 'no-events',
      message: 'No sessions have been loaded yet, so there is nothing to look the id up in.',
      event: null,
    };
  }

  const hit = list.find((e) => String(e?.event_id) === wanted);
  if (hit) return { ok: true, reason: 'resolved', message: '', event: hit };

  return {
    ok: false,
    reason: 'not-in-window',
    // Never "no such event". #97 measured that Clubworx answers 404 for a real
    // id and an invented one alike, so nothing here can tell them apart — and
    // the wrong half of that guess sends staff to re-check an id that is fine.
    message: `That id is not in the dates currently loaded. Widen the window and search again.`,
    event: null,
  };
}

/**
 * The selected events, in timetable order.
 *
 * A selected id with no event behind it is dropped rather than carried as a
 * placeholder: it can only come from a window that has been reloaded under a
 * tick, and a run must never be counted against a session nobody can name.
 */
export function selectedEvents(events, selected) {
  const wanted = new Set((Array.isArray(selected) ? selected : []).map(String));
  return (Array.isArray(events) ? events : [])
    .filter((e) => wanted.has(String(e?.event_id)))
    .sort(byStart);
}

/** A session, in the words that identify it on screen: name, day, time. */
export function sessionLabel(event) {
  const name = String(event?.event_name ?? '').trim() || 'Unnamed session';
  const day = perthDay(event?.event_start_at);
  return day ? `${name}, ${day}` : name;
}

/**
 * What is wrong with one session, and how serious.
 *
 * **The one place that decides this.** It lived in two before — the blocker
 * list here and the page's own row styling — and the two disagreed: a session
 * Clubworx reported full was painted red as refused while this report called it
 * a warning, which is what §11 actually says. Two surfaces contradicting each
 * other about whether a run can proceed is the fault shape §16 records, and the
 * severity is the half that matters.
 *
 * The Worker's `bookable` is deliberately not the answer. It folds *no room in
 * the class* in with *too close to the start*, and only the second of those
 * refuses a booking: #50 measured `spaces_available` wrong in both directions,
 * so §11 makes it "warn, never block". Reading `bookable` alone paints a
 * warnable session as a refused one.
 *
 * @returns {{kind: string, severity: 'block'|'warn', message: string}|null}
 *   null when there is nothing wrong with the session.
 */
export function sessionRefusal(event) {
  const lead = event?.lead ?? {};

  if (lead.unreadable === true) {
    return {
      kind: 'unreadable-session',
      severity: 'block',
      message: 'No readable start time, so the 24-hour rule cannot be checked against it.',
    };
  }

  if (lead.past === true) {
    return { kind: 'past-session', severity: 'block', message: 'Already started.' };
  }

  if (lead.withinLeadTime === true) {
    return {
      kind: 'lead-time',
      severity: 'block',
      // Named here rather than met as Clubworx's own refusal — D9. Its message,
      // "Sorry! This class is now closed for bookings.", names no cause and
      // reads like the class is full.
      message: `Starts in under ${lead.minLeadHours ?? 24} hours, so Clubworx would refuse it.`,
    };
  }

  // Ranked below the lead time on purpose: a session that is both too soon and
  // full is refused for the reason that actually refuses it.
  if (event?.event_full === true || event?.spaces_available === 0) {
    return {
      kind: 'full',
      severity: 'warn',
      message: 'Clubworx reports no spaces — a number that has been wrong in both directions.',
    };
  }

  return null;
}

const REFUSAL_TITLES = {
  'unreadable-session': 'A session has no readable start time',
  'past-session': 'A session has already started',
  'lead-time': 'A session starts too soon to book',
  full: 'Clubworx reports no spaces on a session',
};

const removal = (event) => ({
  key: `remove:${event.event_id}`,
  label: 'Remove this session',
  answers: 'remove',
  value: String(event.event_id),
});

/**
 * Everything step 4 blocks on, and the two numbers step 5 needs from it.
 *
 * Each too-soon session gets **its own** blocker with its own removal, rather
 * than one blocker listing them. D9 makes removing a session a decision staff
 * take one at a time; a single "remove them all" is the silent adjustment with
 * a button on it.
 *
 * @param {object} opts
 * @param {Array<object>} opts.events The loaded window.
 * @param {Array<string>} opts.selected Ticked event ids.
 * @param {number} opts.studentCount Students the run would book.
 * @param {boolean} [opts.truncated] Whether the Worker said it could not read the window to the end.
 * @param {string} [opts.windowTo] The last day loaded, so a series running past it can be named.
 */
export function selectionReport({ events, selected, studentCount = 0, truncated = false, windowTo = '' } = {}) {
  const picked = selectedEvents(events, selected);
  const blockers = [];

  if (picked.length === 0) {
    blockers.push({
      key: 'no-events',
      kind: 'no-events',
      severity: 'block',
      title: 'No sessions picked',
      detail: 'Pick the first session of the series. The rest of the term is ticked with it.',
      actions: [],
    });
  }

  if (studentCount === 0) {
    blockers.push({
      key: 'no-students',
      kind: 'no-students',
      severity: 'block',
      title: 'No students to book',
      detail: 'Nothing came out of the paste as a student, so there is nobody to put in a session.',
      actions: [],
    });
  }

  for (const event of picked) {
    // Asked, never re-decided — see sessionRefusal. A blocker is only offered a
    // removal when it is a `block`: D9's one-click fix answers a session that
    // refuses the run, and offering it beside a warning turns "worth a look"
    // into "click here to make this go away".
    const refusal = sessionRefusal(event);
    if (refusal) {
      blockers.push({
        key: `${refusal.kind}:${event.event_id}`,
        kind: refusal.kind,
        severity: refusal.severity,
        title: REFUSAL_TITLES[refusal.kind],
        detail: `${sessionLabel(event)} — ${refusal.message}`,
        actions: refusal.severity === 'block' ? [removal(event)] : [],
      });
    }

    // Room is a second question from "is it full", and both are warnings.
    // A null is not a zero — it is Clubworx declining to say, passed through
    // untouched by the Worker for exactly this reason.
    const spaces = event.spaces_available;
    if (refusal?.kind !== 'full' && typeof spaces === 'number' && studentCount > 0 && spaces < studentCount) {
      blockers.push({
        key: `spaces:${event.event_id}`,
        kind: 'spaces',
        severity: 'warn',
        title: 'A session may not have room',
        detail: `${sessionLabel(event)} reports ${plural(spaces, 'space')} for ${plural(studentCount, 'student')}. `
          + 'That number has been wrong in both directions, so it is worth a look and not worth obeying.',
        actions: [],
      });
    }
  }

  const reach = seriesReach({ events, selected, windowTo });
  if (!reach.complete) {
    blockers.push({
      key: 'series-reach',
      kind: 'series-reach',
      severity: 'warn',
      title: 'This series may run past the dates loaded',
      detail: reach.message,
      actions: [],
    });
  }

  if (truncated) {
    blockers.push({
      key: 'truncated',
      kind: 'truncated',
      severity: 'warn',
      title: 'The session list was cut short',
      detail: 'The date window holds more sessions than could be read. Narrow the dates if the '
        + 'session you want is missing.',
      actions: [],
    });
  }

  const days = picked.map((e) => perthDay(e.event_start_at)).filter(Boolean).sort();

  return {
    events: picked,
    blockers,
    ready: !blockers.some((b) => b.severity === 'block'),
    sessions: picked.length,
    students: studentCount,
    bookings: picked.length * studentCount,
    firstSession: days[0] ?? null,
    // What the pass has to cover (§10 D4, ADR 0005) — the **last** selected
    // session, not today.
    lastSession: days[days.length - 1] ?? null,
  };
}

/**
 * Could the ticked series continue past the dates that were loaded?
 *
 * Nothing loads until the operator names a window, so the window is theirs to
 * get wrong — and `preTicked` can only tick what the window holds. A `to` that
 * stops mid-term therefore books a partial series, silently, which is the one
 * thing deferring the load makes *worse* rather than better.
 *
 * The projection is the honest form of the question. Two ticked sessions give
 * an interval, so the next one in the series is predictable; if that date falls
 * **inside** the loaded window then the walk would have found it, and its
 * absence is evidence the series has ended. If it falls **past** the window, the
 * walk never looked there and nothing on this page knows either way.
 *
 * The **median** gap, not the last one: a cancelled week leaves a 14-day hole,
 * and projecting from that alone pushes the expectation a fortnight out and
 * hides a real edge.
 *
 * One session is not a series. With no interval there is nothing to project,
 * and inventing one would warn about a session nobody has evidence for.
 *
 * @returns {{complete: boolean, nextExpected: string|null, message: string}}
 */
export function seriesReach({ events, selected, windowTo } = {}) {
  const settled = { complete: true, nextExpected: null, message: '' };

  const picked = selectedEvents(events, selected);
  if (picked.length < 2 || !windowTo) return settled;

  const days = picked.map((e) => perthDay(e.event_start_at)).filter(Boolean);
  if (days.length < 2) return settled;

  const gaps = [];
  for (let i = 1; i < days.length; i += 1) {
    gaps.push(Math.round((Date.parse(`${days[i]}T00:00:00Z`) - Date.parse(`${days[i - 1]}T00:00:00Z`)) / 86_400_000));
  }
  gaps.sort((a, b) => a - b);
  // The **lower** middle on an even count, which is the safe direction: a
  // shorter gap projects the next session sooner, so the doubt is raised rather
  // than suppressed. Taking the upper middle lets one cancelled week — a single
  // 14-day hole among sevens — push the expectation past the window edge and
  // silence the warning at exactly the moment it is right.
  const gap = gaps[Math.floor((gaps.length - 1) / 2)];
  if (!Number.isFinite(gap) || gap <= 0) return settled;

  const last = days[days.length - 1];
  const next = new Date(`${last}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + gap);
  const nextExpected = next.toISOString().slice(0, 10);

  if (nextExpected <= windowTo) return settled;

  return {
    complete: false,
    nextExpected,
    message: `If this series runs on, the next session would be about ${nextExpected} — past `
      + `${windowTo}, the last date loaded. Widen the dates and search again to be sure the whole `
      + 'term is ticked.',
  };
}

/** The multiplication, on screen, because it is the number that surprises people. */
export function sessionsLine({ sessions = 0, students = 0, bookings = 0 } = {}) {
  if (sessions === 0) return '';
  return `${plural(sessions, 'session')} × ${plural(students, 'student')} = ${plural(bookings, 'booking')}.`;
}
