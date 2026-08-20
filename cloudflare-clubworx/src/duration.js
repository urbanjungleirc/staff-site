/**
 * The plan's duration, and the day a pass granted today stops covering.
 *
 * staff-site#69. Design: `docs/superpowers/specs/2026-08-19-school-group-booking-design.md`
 * §3, §10 (D4) and §11; [ADR 0005](../../docs/adr/0005-school-pass-runs-26-weeks.md).
 *
 * ---------------------------------------------------------------------------
 * Why the number 26 is not in this file, or in any other
 * ---------------------------------------------------------------------------
 * The School Pass ran 12 weeks until 2026-08-20 and runs 26 now, and the change
 * needed no code because nothing here holds the number. The duration is read off
 * the plan (`membership_duration`) and the expiry is read off the granted pass
 * (`expiration_date`); this module only turns the first into a date so the run
 * can be stopped *before* a permanent write when the pass would not reach the
 * last session.
 *
 * A constant here would be a second copy of a number that lives in Clubworx's
 * configuration, and the failure it causes is the one ADR 0005 exists to fix:
 * silent, weeks late, at a session nobody is watching.
 *
 * ---------------------------------------------------------------------------
 * `membership_duration` is a human string
 * ---------------------------------------------------------------------------
 * `"12 weeks"`, `"26 weeks"` — prose typed into a plan editor, not an interval
 * type. So it is parsed best-effort, and **an unparseable value is a warning
 * that names the raw string, never a silent skip** (§11). The coverage check is
 * the only thing standing between a shortened plan and a term whose last
 * sessions quietly fall outside the pass; skipping it without saying so
 * reproduces exactly the bug ADR 0005 was written for.
 *
 * A value this cannot parse also cannot be *guessed*. `parsePlanDuration`
 * refuses rather than falling back to a default, because a wrong default is
 * indistinguishable from a right one until a term is half over.
 *
 * ---------------------------------------------------------------------------
 * The arithmetic is inclusive at both ends, because Clubworx's is
 * ---------------------------------------------------------------------------
 * Measured (#60, #63): a 12-week pass starting 2026-08-20 came back with
 * `expiration_date 2026-11-11` — 84 days of access, 83 days of difference. So
 * the last covered day is `start + days - 1`, and a one-day pass covers its own
 * start day. Off by one here is off by one session.
 */

/**
 * `YYYY-MM-DD`, and a real day.
 *
 * Shared with the route's own validation. `new Date('2009-02-30')` does not
 * throw — it rolls forward to 2 March — so the round-trip is what catches it.
 * A date that rolls is the standing hazard on this map (§7): `03/02/2009` is two
 * different children, and a wrong one is a permanent contact keyed to the wrong
 * birthday.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isRealDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Add whole days to an ISO day, in UTC.
 *
 * UTC on purpose. These are plain dates with no time and no zone — Clubworx
 * stores `start_date` and `expiration_date` as `YYYY-MM-DD` — so doing the
 * arithmetic in the runtime's local zone would make the answer depend on where
 * the isolate happens to be, and a Worker's local zone is UTC anyway while a
 * developer's is AWST. One of those two would be silently wrong.
 *
 * @param {string} day `YYYY-MM-DD`.
 * @param {number} count
 * @returns {string|null} `YYYY-MM-DD`, or null if the input was not a real day.
 */
export function addDays(day, count) {
  if (!isRealDay(day) || !Number.isInteger(count)) return null;
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + count);
  return at.toISOString().slice(0, 10);
}

/** What a duration may be counted in. Singular; the parser strips the plural. */
const UNITS = new Set(['day', 'week', 'month', 'year']);

/**
 * Read `membership_duration` off a plan.
 *
 * @param {unknown} raw The plan's `membership_duration`, exactly as Clubworx sent it.
 * @returns {{ok: true, count: number, unit: 'day'|'week'|'month'|'year', raw: string}
 *        | {ok: false, raw: string}}
 */
export function parsePlanDuration(raw) {
  const text = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  const failed = { ok: false, raw: typeof raw === 'string' ? raw : String(raw ?? '') };

  // A whole number and a unit, in that order, and nothing else. Deliberately
  // narrow: "3 to 6 months" and "a term" must land in the warning, not in an
  // arithmetic that half-understood them.
  const match = /^(\d+)\s*(day|week|month|year)s?$/.exec(text);
  if (!match) return failed;

  const count = Number(match[1]);
  const unit = match[2];
  // Zero is not a short pass, it is a misconfigured plan — and it would make
  // every coverage check fail in a way that reads like a lead-time problem.
  if (!Number.isInteger(count) || count <= 0 || !UNITS.has(unit)) return failed;

  return { ok: true, count, unit, raw: String(raw) };
}

/**
 * The last day a pass granted on `startDay` still covers.
 *
 * Inclusive at both ends, matching the measured `expiration_date` (see the
 * header). Months and years use calendar arithmetic rather than a 30- or
 * 365-day approximation, so a plan configured in months does not drift.
 *
 * Returns **null** rather than a plausible date when the duration did not parse
 * or the start day is not real. A caller that treats null as "no limit" has
 * skipped the check silently, which §11 forbids — every caller here turns null
 * into a named warning instead.
 *
 * @param {string} startDay `YYYY-MM-DD` — the day the pass starts, which for a
 *   pass this tool grants is the day of the run (#63: Clubworx chooses today).
 * @param {ReturnType<typeof parsePlanDuration>} duration
 * @returns {string|null}
 */
export function passCoverageEnd(startDay, duration) {
  if (!duration?.ok || !isRealDay(startDay)) return null;

  const { count, unit } = duration;
  if (unit === 'day') return addDays(startDay, count - 1);
  if (unit === 'week') return addDays(startDay, count * 7 - 1);

  const at = new Date(`${startDay}T00:00:00Z`);
  // Clamp rather than let setUTCMonth roll: 31 January plus one month is not
  // 3 March. Clamping shortens the window, which is the safe direction — this
  // number decides whether a run is allowed to write anything permanent.
  const targetMonth = at.getUTCMonth() + (unit === 'month' ? count : count * 12);
  const dayOfMonth = at.getUTCDate();
  at.setUTCDate(1);
  at.setUTCMonth(targetMonth);
  const lastOfTarget = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 0)).getUTCDate();
  at.setUTCDate(Math.min(dayOfMonth, lastOfTarget));

  return addDays(at.toISOString().slice(0, 10), -1);
}
