// school-booking/calendar.js
//
// The month grid behind the house date picker, as data. The page imports this
// and publishes it as `window.schoolBookingCalendar`.
//
// staff-site#106.
//
// ---------------------------------------------------------------------------
// Why the page does not use `<input type="date">`
// ---------------------------------------------------------------------------
// The browser's own picker is a different control in every browser and on every
// platform, and none of them look like this site. `roster.html` already draws a
// house calendar — the `.dp-*` block in its stylesheet — so the school booking
// page draws the same one, and this module is the half of it that can be tested.
//
// roster.html builds its grid imperatively against live `Date` objects. That
// suits a page with one picker and no framework; this page has two pickers and
// Alpine, so the grid is a value here and the markup is an `x-for` over it.
// Nothing this module returns is ever a function — the same rule steps.js keeps,
// for the same reason (§16).
//
// ---------------------------------------------------------------------------
// Everything is a `YYYY-MM-DD` day, and the arithmetic is UTC
// ---------------------------------------------------------------------------
// A day is what the Worker wants (`/events` refuses a window that is not two
// real days) and a day is what the picker shows, so a day is the only type that
// travels. Building the grid in UTC keeps a cell from shifting under a machine
// in a different timezone; only `todayInPerth` looks at a clock, and it looks at
// Perth's because that is where the gym is.

// Same constant and the same reasoning as events.js. Neither file can import
// the Worker's `duration.js` — that module ships with the Worker.
const AWST_OFFSET_MS = 8 * 60 * 60 * 1000;

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Is this a real calendar day, written `YYYY-MM-DD`?
 *
 * The rollover is the whole point. `new Date('2026-02-30')` does not throw — it
 * quietly becomes 2 March — so a date that cannot exist reaches the Worker as a
 * window shifted by two days, and the sessions that go missing from the picker
 * have nothing on screen to explain them. Parsing and then checking the parts
 * came back unchanged is what catches it.
 */
export function isRealDay(value) {
  const match = DAY.exec(String(value ?? ''));
  if (!match) return false;

  const [, year, month, day] = match.map(Number);
  const at = new Date(Date.UTC(year, month - 1, day));

  return at.getUTCFullYear() === year
    && at.getUTCMonth() === month - 1
    && at.getUTCDate() === day;
}

/**
 * The month a day falls in, or null when the day is not one.
 *
 * `month` counts from **zero**, matching `Date.prototype.getMonth` and the grid
 * roster.html builds. One calendar on this site counting from 0 and another
 * from 1 is an off-by-one waiting for whoever copies between them.
 */
export function monthOf(day) {
  if (!isRealDay(day)) return null;
  const [, year, month] = DAY.exec(day).map(Number);
  return { year, month: month - 1 };
}

/** Walk `delta` months, rolling the year at both ends. */
export function shiftMonth(year, month, delta) {
  const at = new Date(Date.UTC(year, month + delta, 1));
  return { year: at.getUTCFullYear(), month: at.getUTCMonth() };
}

/** `August 2026`, in Australian English. */
export function monthLabel(year, month) {
  return new Date(Date.UTC(year, month, 1))
    .toLocaleDateString('en-AU', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** The calendar day an instant falls on **in Perth**, or null if it cannot be read. */
export function todayInPerth(now = new Date()) {
  const at = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(at.getTime())) return null;
  return new Date(at.getTime() + AWST_OFFSET_MS).toISOString().slice(0, 10);
}

const iso = (year, month, day) =>
  `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

/**
 * One month, as a Monday-first grid of cells.
 *
 * Leading blanks come first so the columns line up under Mo–Su, matching the
 * house calendar. A blank carries nothing to click or read: it is `disabled`
 * and its `iso` is null, so markup that forgets to check `empty` still cannot
 * select one.
 *
 * `min`/`max` are **inclusive** at both ends — they are days, not a half-open
 * range, and a picker that quietly excludes its own last day is the kind of
 * fault nobody reports because it looks like the date simply was not there.
 *
 * @param {number} year
 * @param {number} month Counting from zero — see monthOf.
 * @param {{selected?: string, today?: string, min?: string, max?: string}} [opts]
 * @returns {Array<{key: string, day: number|null, iso: string|null, empty: boolean,
 *                  selected: boolean, today: boolean, disabled: boolean, label: string}>}
 */
export function monthGrid(year, month, { selected, today, min, max } = {}) {
  // Monday = 0. `getUTCDay` puts Sunday at 0, so the shift is +6 mod 7.
  const firstDayOfWeek = (new Date(Date.UTC(year, month, 1)).getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

  const cells = [];

  for (let i = 0; i < firstDayOfWeek; i += 1) {
    cells.push({
      // Keyed, because Alpine needs one per cell and two blanks are otherwise
      // indistinguishable — a duplicate key silently drops a cell from an x-for.
      key: `blank-${i}`,
      day: null,
      iso: null,
      empty: true,
      selected: false,
      today: false,
      disabled: true,
      label: '',
    });
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    const value = iso(year, month, day);
    cells.push({
      key: value,
      day,
      iso: value,
      empty: false,
      selected: value === selected,
      today: value === today,
      disabled: (isRealDay(min) && value < min) || (isRealDay(max) && value > max),
      // A bare number is not a label. Screen readers read the button, and "21"
      // on its own says nothing about which month is open.
      label: new Date(`${value}T00:00:00Z`).toLocaleDateString('en-AU', {
        weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC',
      }),
    });
  }

  return cells;
}
