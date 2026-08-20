/**
 * Does this student already hold a School Pass that reaches the last session?
 *
 * staff-site#69. Design: `docs/superpowers/specs/2026-08-19-school-group-booking-design.md`
 * §10 (D4, D14), §13; ADR 0005 (`docs/adr/0005-school-pass-runs-26-weeks.md`).
 *
 * `summariseMemberships` is **promoted from `probes/lib/report.mjs`**, not
 * re-implemented — the same treatment `errorMessageOf` and `buildUrl` had before
 * it (§6). It was written against a real membership record read live on
 * 2026-08-18, and re-deriving it would re-derive the one thing it exists to
 * prevent:
 *
 * ---------------------------------------------------------------------------
 * A membership has no `status` field
 * ---------------------------------------------------------------------------
 * Verified against a live record. There is `start_date` and `expiration_date`
 * and nothing that says "active". Code that reaches for `status` reads
 * `undefined`, decides the pass is inactive, and grants a **second permanent
 * membership** to somebody who already holds a live one — and memberships have
 * no delete (§12). So activity is derived from the two dates, inclusive at both
 * ends, in exactly one place.
 *
 * ---------------------------------------------------------------------------
 * "Active today" is the wrong question — and it is the question that hid a bug
 * ---------------------------------------------------------------------------
 * `assessPass` compares the held pass against the **latest selected session**,
 * never against today. Every booking in a run is written on the day of the run,
 * when the pass is unambiguously active, so a pass that expires mid-term looks
 * perfect at write time and fails weeks later at a session nobody is watching.
 * That is the whole of ADR 0005.
 *
 * The 26-week pass does not remove the trap — it makes it **more** common. Under
 * 12 weeks a returning student's pass had usually lapsed, so the grant was
 * clean; at 26 weeks the tool regularly finds one that is live and expires
 * before the term ends.
 *
 * ---------------------------------------------------------------------------
 * Why a live-but-short pass refuses instead of granting
 * ---------------------------------------------------------------------------
 * Granting the covering pass to a live holder means putting a **second** School
 * Pass on an active member — the one thing on this effort deliberately never
 * probed, because memberships have no delete and the probe would leave the
 * permanent record it was testing for (§15, staff-site#90).
 *
 * D4 closed that question for free while *active* meant "active today". It does
 * not any more. Until #90 answers, this returns `needs-confirmation` and a human
 * decides — §11's standing posture: refuse and let the human fix it, rather than
 * silently adjust.
 */

import { isRealDay } from './duration.js';

/**
 * Reduce a `GET /memberships?contact_key=` body to the pass states on one plan.
 *
 * Bounded on purpose: a membership row carries `member_name` and other record
 * fields, and this Worker is a transit, not a database (§6, D10). Only the plan
 * dates and the class counters leave here.
 *
 * `fields` is the exception, and it is names only, never values. It is how the
 * probes established that **no `status` field exists** — the finding this whole
 * module turns on — and the probe write-ups still print it, so a future schema
 * change is visible rather than inferred.
 *
 * @param {unknown} body
 * @param {string|number|null} [planId] The plan being looked for.
 * @param {{on?: string}} [opts] The day to judge activity against.
 */
export function summariseMemberships(body, planId = null, { on = null } = {}) {
  if (!Array.isArray(body)) {
    return {
      count: 0,
      fields: [],
      holdsPlan: false,
      holdsActivePlan: false,
      planStates: [],
      notAnArray: true,
    };
  }

  const today = (on ?? new Date().toISOString()).slice(0, 10);
  const fields = new Set();
  const planStates = [];
  let holdsPlan = false;
  let holdsActivePlan = false;

  for (const row of body) {
    // Names only. A value here would be a student's, and this Worker writes
    // nothing down — but knowing which fields exist is what caught the missing
    // `status`.
    for (const key of Object.keys(row ?? {})) fields.add(key);

    // String on both sides: Clubworx has sent this id as a number and as a
    // string, and `64189 !== '64189'` would read a held pass as not held.
    if (planId === null || String(row?.membership_plan_id) !== String(planId)) continue;
    holdsPlan = true;

    const start = row?.start_date ?? null;
    const expires = row?.expiration_date ?? null;
    // Plain `YYYY-MM-DD`, so string comparison IS the date comparison and there
    // is no timezone to get wrong. Inclusive at both ends: a pass starting today
    // is usable today.
    const active = (!start || start <= today) && (!expires || expires >= today);
    if (active) holdsActivePlan = true;

    planStates.push({
      start_date: start,
      expiration_date: expires,
      active,
      classes_booked: row?.classes_booked ?? null,
      classes_remaining: row?.classes_remaining ?? null,
      class_access: row?.class_access ?? null,
    });
  }

  return {
    count: body.length,
    fields: [...fields],
    holdsPlan,
    holdsActivePlan,
    planStates,
    notAnArray: false,
  };
}

/** Unbounded sorts last, so a row with no expiry is the best one held. */
const UNBOUNDED = '9999-12-31';

/**
 * D4's verdict: grant a School Pass, skip it, or stop and ask a human.
 *
 * | State | Grant? | Why |
 * |---|---|---|
 * | `none` | yes | Holds nothing on this plan |
 * | `expired` | yes | Every held pass ended before today — a clean grant |
 * | `covering` | no | A live pass already reaches the last selected session |
 * | `needs-confirmation` | no | Live but short, or not started — a second pass on a live holder (#90) |
 * | `unknown` | no | A date this cannot compare. Never guess before a permanent write |
 *
 * @param {object} opts
 * @param {Array<{start_date: string|null, expiration_date: string|null, active: boolean}>} opts.states
 *   `planStates` from `summariseMemberships`, so the no-`status` rule applies once.
 * @param {string} opts.lastSession `YYYY-MM-DD` — the latest selected session.
 * @param {string} opts.on `YYYY-MM-DD` — the day of the run.
 */
export function assessPass({ states = [], lastSession, on }) {
  const held = (Array.isArray(states) ? states : []).filter(Boolean);

  if (!isRealDay(lastSession) || !isRealDay(on)) {
    return {
      state: 'unknown',
      grant: false,
      expirationDate: null,
      lastSession: lastSession ?? null,
      detail:
        'the pass cannot be assessed: the run date or the last session date is not a YYYY-MM-DD day, ' +
        'and a pass is not granted on a date this cannot compare',
    };
  }

  if (held.length === 0) {
    return {
      state: 'none',
      grant: true,
      expirationDate: null,
      lastSession,
      detail: 'no School Pass on this plan',
    };
  }

  // Best first, so several held rows cannot let a lapsed one speak for a live one.
  const byExpiry = [...held].sort((a, b) =>
    String(b.expiration_date ?? UNBOUNDED).localeCompare(String(a.expiration_date ?? UNBOUNDED)),
  );

  const covering = byExpiry.find(
    s =>
      (!s.start_date || s.start_date <= on) &&
      (!s.expiration_date || s.expiration_date >= lastSession),
  );
  if (covering) {
    return {
      state: 'covering',
      grant: false,
      expirationDate: covering.expiration_date ?? null,
      lastSession,
      detail:
        'holds a School Pass to ' +
        (covering.expiration_date ?? 'no expiry') +
        ', which covers the last session on ' +
        lastSession,
    };
  }

  // Live today, or dated to start later. Either way granting now puts a second
  // pass on a holder whose first one has not run out — the unprobed case (#90).
  const live = byExpiry.find(s => s.active || (s.start_date && s.start_date > on));
  if (live) {
    return {
      state: 'needs-confirmation',
      grant: false,
      expirationDate: live.expiration_date ?? null,
      lastSession,
      detail:
        'holds a School Pass that runs ' +
        (live.start_date ?? 'no start') +
        ' to ' +
        (live.expiration_date ?? 'no expiry') +
        ', which does not reach the last selected session on ' +
        lastSession +
        '. Granting a second pass to a live holder has never been tested and cannot be undone — ' +
        'a human decides this one.',
    };
  }

  const latest = byExpiry[0]?.expiration_date ?? null;
  return {
    state: 'expired',
    grant: true,
    expirationDate: latest,
    lastSession,
    detail: 'holds a School Pass that expired on ' + (latest ?? 'an unknown date'),
  };
}
