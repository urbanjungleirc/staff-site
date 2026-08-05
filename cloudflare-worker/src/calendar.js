/**
 * WA school term data and UJ term-week classification.
 *
 * This module is an implementation detail of the `/api/calendar` route. It is
 * not a test seam — everything here is observable through that route, and the
 * tests go through it. See docs/adr/0002-uj-term-weeks-are-snapped.md.
 *
 * Every date in here is a plain `YYYY-MM-DD` calendar date in Australia/Perth.
 * There are no UTC instants in the classification path; `Date.UTC` appears only
 * as fixed-size civil-day arithmetic, never to convert a moment in time.
 */

/**
 * WA public school term dates, as published in the Government Gazette.
 *
 * Source: https://www.education.wa.edu.au/future-term-dates
 * Last verified: 2026-08-05, by re-reading the page rather than trusting a parse.
 *
 * 2029 onward are published as "Preliminary dates only, to be confirmed" and
 * may move. When they do, the tests will not notice — re-read the page.
 *
 * No machine-readable source for these exists: they are absent from both
 * data.wa.gov.au and data.gov.au, and the public-holiday feed's school-holiday
 * data stops in December 2026. Hence the hardcoded table.
 *
 * Deliberately duplicated from the UJ customer tools site
 * (`tools-site/gas/ClubworxAPI/Code.js`), which keeps its own copy for a
 * different consumer. That repository is not to be modified from here; the two
 * copies were verified identical on 2026-08-05.
 */
const WA_SCHOOL_TERMS = {
  2025: [
    { start: "2025-02-05", end: "2025-04-11" },
    { start: "2025-04-28", end: "2025-07-04" },
    { start: "2025-07-21", end: "2025-09-26" },
    { start: "2025-10-13", end: "2025-12-18" },
  ],
  2026: [
    { start: "2026-02-02", end: "2026-04-02" },
    { start: "2026-04-20", end: "2026-07-03" },
    { start: "2026-07-20", end: "2026-09-25" },
    { start: "2026-10-12", end: "2026-12-17" },
  ],
  2027: [
    { start: "2027-02-01", end: "2027-04-09" },
    { start: "2027-04-26", end: "2027-07-02" },
    { start: "2027-07-19", end: "2027-09-24" },
    { start: "2027-10-11", end: "2027-12-16" },
  ],
  2028: [
    { start: "2028-02-02", end: "2028-04-07" },
    { start: "2028-04-24", end: "2028-06-30" },
    { start: "2028-07-17", end: "2028-09-22" },
    { start: "2028-10-09", end: "2028-12-14" },
  ],
  // Preliminary dates only, to be confirmed.
  2029: [
    { start: "2029-01-31", end: "2029-03-29" },
    { start: "2029-04-16", end: "2029-06-29" },
    { start: "2029-07-16", end: "2029-09-21" },
    { start: "2029-10-08", end: "2029-12-19" },
  ],
  // Preliminary dates only, to be confirmed.
  2030: [
    { start: "2030-02-04", end: "2030-04-12" },
    { start: "2030-04-29", end: "2030-07-05" },
    { start: "2030-07-22", end: "2030-09-27" },
    { start: "2030-10-14", end: "2030-12-19" },
  ],
  // Preliminary dates only, to be confirmed.
  2031: [
    { start: "2031-02-03", end: "2031-04-10" },
    { start: "2031-04-28", end: "2031-07-04" },
    { start: "2031-07-21", end: "2031-09-26" },
    { start: "2031-10-13", end: "2031-12-17" },
  ],
};

// How far either side of today the per-date map reaches.
const WINDOW_PAST_DAYS = 30;
const WINDOW_FUTURE_DAYS = 90;

// How close to the end of the table counts as ageing.
const AGEING_MONTHS = 6;

const MS_PER_DAY = 86400000;

const pad = n => String(n).padStart(2, "0");

/** Civil date → whole days since 1970-01-01. Not an instant. */
function toDayNumber(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / MS_PER_DAY;
}

/** Whole days since 1970-01-01 → civil date. */
function toYmd(dayNumber) {
  const d = new Date(dayNumber * MS_PER_DAY);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** 0 = Monday … 6 = Sunday. 1970-01-01 was a Thursday. */
const weekdayFromMonday = dayNumber => (dayNumber + 3) % 7;

/** Add calendar months, clamping to the length of the target month. */
function addMonths(ymd, months) {
  const [y, m, d] = ymd.split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${pad(month)}-${pad(Math.min(d, lastDay))}`;
}

/**
 * Term snapping: expand each official term outward to whole UJ term weeks.
 *
 * Week 1 begins the Monday of the week containing the official start, even when
 * school starts mid-week; the final week runs through the Sunday of the week
 * containing the official end. UJ classes run Mon–Sat regardless of where the
 * official dates fall, so the first Saturday after school finishes is still
 * term for us. This deliberately deviates from the official WA definition,
 * which runs breaks Saturday→Sunday. Do not "correct" it — the week numbers
 * depend on it. ADR 0002 records why.
 */
const SNAPPED_TERMS = Object.keys(WA_SCHOOL_TERMS)
  .map(Number)
  .sort((a, b) => a - b)
  .flatMap(year =>
    WA_SCHOOL_TERMS[year].map((official, index) => {
      const start = toDayNumber(official.start) - weekdayFromMonday(toDayNumber(official.start));
      const end = toDayNumber(official.end) + (6 - weekdayFromMonday(toDayNumber(official.end)));
      return {
        year,
        term: index + 1,
        start,
        end,
        weeks: (end - start + 1) / 7,
      };
    })
  );

const TABLE_STARTS = SNAPPED_TERMS[0].start;
const TABLE_ENDS = SNAPPED_TERMS[SNAPPED_TERMS.length - 1].end;

// The last date the table can classify.
const TERM_TABLE_COVERS_TO = toYmd(TABLE_ENDS);

/**
 * Describe a single day.
 *
 * A break advertises the first day the table will itself call term — the
 * snapped Monday, not the official start — so the endpoint never contradicts
 * itself the following day.
 */
function classify(dayNumber) {
  if (dayNumber < TABLE_STARTS || dayNumber > TABLE_ENDS) {
    return { state: "unknown", publicHoliday: null };
  }

  // Guaranteed to find one: the guard above put dayNumber inside the table.
  const term = SNAPPED_TERMS.find(candidate => dayNumber <= candidate.end);

  if (dayNumber < term.start) {
    // After the previous term's Sunday, before this one's Monday.
    return {
      state: "break",
      nextTerm: term.term,
      nextTermStart: toYmd(term.start),
      publicHoliday: null,
    };
  }

  return {
    state: "term",
    term: term.term,
    week: Math.floor((dayNumber - term.start) / 7) + 1,
    weeksInTerm: term.weeks,
    publicHoliday: null,
  };
}

/**
 * Build the per-date calendar map for a window around the given Perth date.
 * The client looks a date up and renders it; it computes nothing.
 */
export function buildCalendar(todayYmd) {
  const today = toDayNumber(todayYmd);
  const calendar = {};
  for (let offset = -WINDOW_PAST_DAYS; offset <= WINDOW_FUTURE_DAYS; offset++) {
    calendar[toYmd(today + offset)] = classify(today + offset);
  }

  return {
    calendar,
    meta: {
      termTableCoversTo: TERM_TABLE_COVERS_TO,
      // The only thing standing between the table expiring and staff silently
      // losing term context. Load-bearing, not decoration.
      termTableAgeing: addMonths(todayYmd, AGEING_MONTHS) >= TERM_TABLE_COVERS_TO,
    },
  };
}

/** Today's calendar date in Perth. The gym has one timezone and no DST. */
export function perthToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Perth",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
