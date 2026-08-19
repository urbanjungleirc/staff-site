// school-booking/parse.js
//
// Turns a pasted school student list into rows, per-row parse state, and the
// list-level inferences that go with them. Pure on purpose — no DOM, no
// network, no clock — so every rule below is unit-testable. The page imports
// this and publishes it as `window.schoolListParser`, the same seam
// delete-logic.js, unsubscribes-logic.js and image-pipeline.js use.
//
// Rules are §7 of docs/superpowers/specs/2026-08-19-school-group-booking-design.md,
// settled on #52 against the three real lists catalogued in #48. Vocabulary is
// CONTEXT.md § "Clubworx school list parsing".
//
// Why none of this is cosmetic: under the member + School Pass route a student
// is three writes and only the last is reversible, so a parsing misread creates
// a permanent wrong contact carrying a permanent membership.
//
// The two rules everything else leans on:
//
//   P1 — never drop a line, only classify it. Every input line lands in exactly
//        one bucket, and `counts.accounted === counts.lines` is checked here
//        rather than left to the caller.
//   P4 — the DOB is the anchor. Layout and column mapping are both validated by
//        finding the date by the *shape of its values*, never by position or
//        header text. Neither holding is a refusal, not a guess.

// ---------------------------------------------------------------------------
// P10 — two normalisations, kept apart
// ---------------------------------------------------------------------------
// The split is load-bearing: it is what lets `O'Brien` match `OBrien` without
// ever *writing* the second spelling into a record that cannot be deleted. One
// of the three real lists is a PDF exported from Word, so curly apostrophes and
// non-breaking hyphens are expected input — written verbatim they produce a
// contact no human-typed search will ever match again.
//
// The matching rules that consume compare form live in identity.js (#65); what
// this module owes is that both forms are emitted for every row. That module
// must **import** the two functions below rather than restate their rules: two
// copies of one normalisation table will drift, and the drift is silent in the
// worst way. The day compare form disagrees with itself, `O'Brien` stops
// matching `OBrien`, a student who already has a contact comes back as `new`,
// and a second permanent contact is written for them — with nothing thrown,
// because both spellings are individually valid and contacts cannot be deleted.

const ZERO_WIDTH = /[​‌‍⁠﻿]/g;
const SPACEY = /[    ]/g; // NBSP, figure space, narrow NBSP, thin space
const APOSTROPHES = /[‘’ʼʹ′]/g; // curly quotes, modifier letter, prime
const HYPHENS = /[‐‑‒–−]/g; // hyphen, non-breaking, figure dash, en dash, minus

// Case is never touched and accents are never stripped. Both are deliberate:
// this string is written into a permanent record.
export function writeForm(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(ZERO_WIDTH, '')
    .replace(SPACEY, ' ')
    .replace(APOSTROPHES, "'")
    .replace(HYPHENS, '-')
    .normalize('NFC')
    .trim()
    .replace(/\s+/g, ' ');
}

// A Latin letter and the combining marks NFD split off it. Written as escapes
// because raw combining marks reattach to the bracket in editors, diffs and
// greps — the class either side of this one enumerates its codepoints in a
// comment for the same reason.
//
// Two narrowings, both deliberate, because a **false** match is the worse
// failure here: it attaches a permanent pass and bookings to the wrong child,
// where a miss only creates a duplicate contact.
//
//   1. Not `\p{M}`. In an abugida the vowel signs are marks too, so the wider
//      rule deletes letters rather than accents — `प्रिया` becomes `परय`.
//   2. Only marks sitting on a **Latin base letter**. The combining-diacritics
//      block is script-neutral: unqualified it folds Cyrillic `й` onto `и` and
//      `ё` onto `е`, which are separate letters of that alphabet, not accented
//      spellings of one.
//
// What it does **not** narrow, and this is a trade rather than an oversight:
// Vietnamese is Latin script, so `ệ` and `ễ` fold onto `e` and `Lê`, `Lệ` and
// `Lễ` share one compare form. That is accepted because it is the case #80 was
// filed about — a school types `Nguyen`, the contact record says `Nguyễn` — and
// a false match additionally needs the surname, the birthday and the first name
// to coincide, where the miss it prevents is routine. Tested both ways below.
const ACCENTED_LATIN = /(\p{Script=Latin})[\u0300-\u036f]+/gu;

// Matching and in-paste dedup only. Never written anywhere.
//
// Accents fold here and nowhere else (#80). It is the same class of variance as
// the apostrophe: one list types it, one contact record does not, and in a
// surname the mismatch is silent — the candidate never narrows, an existing
// student reports `new`, and a second permanent contact is written for them.
//
// Known limit: a letter carrying its stroke inside itself does not decompose, so
// no mark-stripping rule reaches it. `Wałęsa` matches `Wałesa`, not `Walesa`.
export function compareForm(value) {
  return writeForm(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(ACCENTED_LATIN, '$1')
    // Back to NFC, because NFD also splits Hangul syllables into jamo and every
    // mark this rule deliberately leaves alone stays split without it. Two
    // strings that look identical would then compare unequal — the exact failure
    // this function exists to prevent, arrived at from the other direction.
    .normalize('NFC')
    .replace(/['\-\s]/g, '');
}

// ---------------------------------------------------------------------------
// Date shapes — the anchor (P4), the orientation (P11), the serials (P12)
// ---------------------------------------------------------------------------

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const PARTED = /^(\d{1,4})[/.-](\d{1,2})[/.-](\d{2,4})$/;
const SERIAL = /^\d{5}$/;

// Excel's 1900 system, using the 1899-12-30 base that absorbs its leap-year bug
// for every serial above 60. The window is 1900–2100: a five-digit integer is
// the weakest date shape there is, and bounding it keeps a column of student
// IDs from reading as dates. It is also why serials are only consulted when no
// unambiguous date shape exists anywhere (see `dateBearing`).
const SERIAL_EPOCH_UTC = Date.UTC(1899, 11, 30);
const SERIAL_MIN = 1;
const SERIAL_MAX = 73415; // 2100-12-31

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeap(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function validDate(year, month, day) {
  if (month < 1 || month > 12 || day < 1) return false;
  const last = month === 2 && isLeap(year) ? 29 : DAYS_IN_MONTH[month - 1];
  return day <= last;
}

const pad = (n, width) => String(n).padStart(width, '0');
const iso = (year, month, day) => `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;

// `strict` excludes bare five-digit serials. Detection runs strict first so a
// list that has a real date column is never anchored on an integer column.
export function isDateShaped(value, { strict = false } = {}) {
  const s = String(value ?? '').trim();
  if (!s) return false;
  if (ISO.test(s)) return true;
  if (PARTED.test(s)) return true;
  if (!strict && SERIAL.test(s)) {
    const n = Number(s);
    return n >= SERIAL_MIN && n <= SERIAL_MAX;
  }
  return false;
}

// Which orientation a single value *proves*, if any. Only a field above 12 is
// proof; everything else — self-identifying, serial, or two fields both under
// 13 — returns null and contributes nothing. P11 is emphatic that this is a
// property of the whole list, so no caller may read a date without one.
export function orientationEvidence(value) {
  const s = String(value ?? '').trim();
  const m = PARTED.exec(s);
  if (!m) return null;
  const [, a, b] = m;
  if (a.length === 4) return null; // yyyy-m-d, self-identifying
  const first = Number(a);
  const second = Number(b);
  if (first > 12 && second <= 12) return 'dmy';
  if (second > 12 && first <= 12) return 'mdy';
  return null; // both above 12 is invalid, both under 13 is ambiguous
}

// `{ iso, kind }` on success, `{ error }` on a date-shaped value that is not a
// date. `orientation` may be null, in which case an ambiguous parted date is
// reported as needing it rather than guessed.
export function readDate(value, orientation) {
  const s = String(value ?? '').trim();
  if (!s) return { error: 'empty' };

  const isoMatch = ISO.exec(s);
  if (isoMatch) {
    const [, y, m, d] = isoMatch.map(Number);
    return validDate(y, m, d) ? { iso: iso(y, m, d), kind: 'iso' } : { error: 'invalid-date' };
  }

  if (SERIAL.test(s)) {
    const n = Number(s);
    if (n < SERIAL_MIN || n > SERIAL_MAX) return { error: 'invalid-date' };
    // Not unambiguous — 1900 and 1904 are 1462 days apart, so a bare 40365 is
    // either 2010-07-06 or 2014-07-07, both plausible school ages. Which system
    // a workbook uses is unanswerable, so P12 confirms the resulting *dates*
    // instead, which is a question staff can actually answer.
    const date = new Date(SERIAL_EPOCH_UTC + n * 86400000);
    return {
      iso: date.toISOString().slice(0, 10),
      kind: 'serial',
    };
  }

  const parted = PARTED.exec(s);
  if (!parted) return { error: 'not-a-date' };
  const [, a, b, c] = parted;

  if (a.length === 4) {
    const [y, m, d] = [Number(a), Number(b), Number(c)];
    return validDate(y, m, d) ? { iso: iso(y, m, d), kind: 'iso' } : { error: 'invalid-date' };
  }

  // The century constraint: students are all born this century, so a two-digit
  // year is 20xx. (This does not resolve 1900-vs-1904 — both readings land
  // after 2000 — it only fixes the century of a typed year.)
  const year = c.length <= 2 ? 2000 + Number(c) : Number(c);
  const first = Number(a);
  const second = Number(b);

  if (!orientation) {
    if (first > 12 && second > 12) return { error: 'invalid-date' };
    if (first <= 12 && second <= 12) return { error: 'needs-orientation' };
    // A value that proves its own orientation can be read without one.
    const proven = first > 12 ? 'dmy' : 'mdy';
    return readParted(first, second, year, proven);
  }

  return readParted(first, second, year, orientation);
}

function readParted(first, second, year, orientation) {
  const day = orientation === 'dmy' ? first : second;
  const month = orientation === 'dmy' ? second : first;
  if (!validDate(year, month, day)) return { error: 'invalid-date' };
  return { iso: iso(year, month, day), kind: 'parted' };
}

// ---------------------------------------------------------------------------
// P13 — age band, against the event date, in Australia/Perth
// ---------------------------------------------------------------------------
// Generous on purpose: a hard block would refuse the legitimate senior student
// or an 18-year-old on a leadership day, so an implausible age is
// needs-confirmation and never a refusal. Perth has never observed daylight
// saving, so calendar arithmetic on the two ISO dates is exact.

export const MIN_PLAUSIBLE_AGE = 4;
export const MAX_PLAUSIBLE_AGE = 21;

export function ageOn(dobIso, onIso) {
  if (!ISO.test(String(dobIso)) || !ISO.test(String(onIso))) return null;
  const [by, bm, bd] = dobIso.split('-').map(Number);
  const [ey, em, ed] = onIso.split('-').map(Number);
  let age = ey - by;
  if (em < bm || (em === bm && ed < bd)) age -= 1;
  return age;
}

// ---------------------------------------------------------------------------
// Lines and fields
// ---------------------------------------------------------------------------

function splitLines(text) {
  const body = String(text ?? '').replace(/^﻿/, '');
  const lines = body.split(/\r\n|\r|\n/);
  // A trailing newline is a terminator, not an empty final line. Every other
  // blank line is real input and is classified like any other (P1).
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines.map((raw, i) => ({ n: i + 1, raw }));
}

// A pasted list is not necessarily tab-separated — one of the three real lists
// contains no tab and no comma at all. Commas are deliberately *not* a
// delimiter: a comma inside a name field means `Surname, Given` (P8), and a
// parser that split on it would tear that field in half.
function detectDelimiter(lines) {
  const filled = lines.filter((l) => l.raw.trim() !== '');
  if (filled.some((l) => l.raw.includes('\t'))) return 'tab';
  // Two or more spaces, never single whitespace: list 3's columns are aligned
  // with runs of 2–8 spaces, and both a first name and a surname containing a
  // single space appear in the real lists.
  if (filled.some((l) => /\S {2,}\S/.test(l.raw.trim()))) return 'spaces';
  return 'none';
}

function splitFields(raw, delimiter) {
  const trimmed = raw.trim();
  if (trimmed === '') return [];
  let fields;
  if (delimiter === 'tab') fields = raw.split('\t').map((f) => f.trim());
  else if (delimiter === 'spaces') fields = trimmed.split(/\s{2,}/).map((f) => f.trim());
  else fields = [trimmed];
  // A line of nothing but delimiters carries no data, so it is blank — not a
  // one-field row. Appending phantom tabs to a trailing empty line is exactly
  // how this arises, and counting it as content would invent a junk line.
  if (fields.every((f) => f === '')) return [];
  // Phantom trailing columns: styled but empty cells arrive as trailing tabs
  // and turn "this list has 3 columns" into "6 columns, three of them blank".
  // Interior blanks are left alone — those are missing values, not padding.
  while (fields.length > 1 && fields[fields.length - 1] === '') fields.pop();
  return fields;
}

function modalCount(counts) {
  let best = 0;
  let bestN = 0;
  for (const [size, n] of counts) {
    if (n > bestN || (n === bestN && Number(size) > best)) {
      best = Number(size);
      bestN = n;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// P4 — layout, detected then validated against content
// ---------------------------------------------------------------------------
// The divisibility rule as first written on #48 is superseded and deliberately
// not implemented: all three fixtures are CRLF and the vertical one opens with
// a blank line, so its 37 lines are not a multiple of 6 while its 36 non-blank
// lines are — and almost any line count divides by 2 or 3 anyway.
//
// What holds instead is the DOB anchor. In a genuine vertical list exactly one
// position within the repeating block is date-shaped in *every* block, which
// shows up as a constant gap between date-shaped lines. That gap is the block
// size, and it is a measurement rather than a guess.

function detectVertical(seq, strict) {
  const dateAt = seq.map((cell) => isDateShaped(cell.value, { strict }));
  const hits = [];
  dateAt.forEach((isDate, i) => {
    if (isDate) hits.push(i);
  });
  // One date cannot establish a stride, and zero cannot establish anything.
  if (hits.length < 2) return null;

  const gap = hits[1] - hits[0];
  if (gap < 2 || gap > 40) return null;
  for (let i = 2; i < hits.length; i++) {
    if (hits[i] - hits[i - 1] !== gap) return null; // two date positions, or a broken list
  }

  const firstHit = hits[0];
  let start = null;
  for (let p = 0; p <= Math.min(gap - 1, firstHit); p++) {
    const s = firstHit - p;
    if ((seq.length - s) % gap === 0) {
      start = s;
      break;
    }
  }
  // No offset leaves whole blocks to the end — a truncated paste. Keep as many
  // complete blocks as the anchor supports and let the remainder be errors;
  // the count gate (P5) is what catches the truncation itself.
  if (start === null) start = firstHit - Math.min(firstHit, gap - 1);

  const blocks = Math.floor((seq.length - start) / gap);
  if (blocks < 1) return null;
  return { blockSize: gap, start, blocks, dobPos: firstHit - start };
}

// ---------------------------------------------------------------------------
// P6 — columns mapped content-first
// ---------------------------------------------------------------------------
// Fixed column order is rejected outright: the first school that reorders its
// export would produce wrong permanent contacts with no error at all. A header,
// where present, does one job — naming the two *name* columns. It never finds
// the date, and it never decides which columns are ignored.

const NAME_SHAPED = /^[\p{L}][\p{L}\p{M}'\-. ]*$/u;

function isNameShaped(value) {
  const s = String(value ?? '').trim();
  if (!s) return false;
  if (s.includes('@') || /\d/.test(s)) return false;
  return NAME_SHAPED.test(s);
}

const label = (text) => String(text ?? '').toLowerCase().replace(/[^a-z]/g, '');
const FIRST_WORDS = ['first', 'given', 'preferred', 'forename', 'christian', 'nickname'];
const LAST_WORDS = ['last', 'surname', 'family'];
const COMBINED_LABELS = ['name', 'studentname', 'fullname', 'student', 'pupil'];

// A preferred name is a nickname, not the legal name, and the two must stay
// tellable apart: a first-name mismatch against Clubworx is then an *expected*
// outcome of a correct match, which weakens the first-name tie-breaker exactly
// where identity.js (#65) needs it — for twins. One of the three real lists
// ships a column headed `PreferredName`, so this is not hypothetical.
const PREFERRED_WORDS = ['preferred', 'nickname', 'knownas'];

const isPreferredLabel = (text) => PREFERRED_WORDS.some((w) => label(text).includes(w));

function mapColumns(dataRows, width, dobCol, header) {
  const others = [];
  for (let c = 0; c < width; c++) if (c !== dobCol) others.push(c);

  const nameShaped = others.filter((c) =>
    dataRows.every((row) => isNameShaped(row.fields[c]))
  );

  if (header) {
    const first = others.find((c) => FIRST_WORDS.some((w) => label(header[c]).includes(w)));
    const last = others.find((c) => LAST_WORDS.some((w) => label(header[c]).includes(w)));
    if (first !== undefined && last !== undefined && first !== last) {
      return {
        firstName: first,
        lastName: last,
        combined: null,
        nameOrderKnown: true,
        firstNameIsPreferred: isPreferredLabel(header[first]),
      };
    }
    const combined = others.find((c) => COMBINED_LABELS.includes(label(header[c])));
    if (combined !== undefined) {
      return {
        firstName: null,
        lastName: null,
        combined,
        nameOrderKnown: false,
        firstNameIsPreferred: false,
      };
    }
  }

  // Content fallback. Order is not inferable: hyphenated and apostrophe names
  // appear in *both* fields in the real lists, so any content rule for which is
  // which would be a guess dressed as inference. P7 asks instead.
  if (nameShaped.length >= 2) {
    return {
      firstName: nameShaped[0],
      lastName: nameShaped[1],
      combined: null,
      nameOrderKnown: false,
      // Without a header there is nothing that could say so either way, and
      // guessing "legal" would be the silent half of the mistake.
      firstNameIsPreferred: false,
    };
  }
  if (nameShaped.length === 1) {
    return {
      firstName: null,
      lastName: null,
      combined: nameShaped[0],
      nameOrderKnown: false,
      firstNameIsPreferred: false,
    };
  }
  return null;
}

function columnLabel(header, index) {
  const named = header && String(header[index] ?? '').trim();
  return named || `Column ${index + 1}`;
}

// ---------------------------------------------------------------------------
// P8 — a combined name column, with graded confirmation
// ---------------------------------------------------------------------------
// No particle list (van, der, de, mac, o') is maintained: every such name has
// three or more tokens anyway, so the token rule catches them without a list
// that is culturally incomplete by nature and silently wrong when it misses.

// Which half of a document-order split is the given name is P7's question, not
// this function's, so every split routes through here rather than restating the
// nameOrder test at each site.
const ordered = (left, right, nameOrder) =>
  nameOrder === 'last-first'
    ? { firstName: right, lastName: left }
    : { firstName: left, lastName: right };

function splitCombinedName(value, nameOrder, chosenSplit) {
  const name = writeForm(value);
  if (!name) return { firstName: '', lastName: '', needs: null, flag: 'empty-name' };

  if (name.includes(',')) {
    // `Surname, Given` — the only reading a comma has in a name field, and it
    // is explicit about which half is which, so nameOrder does not apply.
    // Confirmed once for the list, not once per row.
    const [surname, ...rest] = name.split(',');
    return {
      firstName: writeForm(rest.join(',')),
      lastName: writeForm(surname),
      needs: null,
      flag: 'comma-split',
    };
  }

  const tokens = name.split(' ');
  if (tokens.length === 2) {
    // Auto-split: no other reading exists. Which way round is P7's problem.
    return { ...ordered(tokens[0], tokens[1], nameOrder), needs: null, flag: null };
  }

  if (tokens.length === 1) {
    // One token cannot be split, so there is no split to confirm and P8's table
    // has no row for it. It is surfaced as a flag — which is enough to hold the
    // row at needs-confirmation — rather than as a question with no answers.
    return { firstName: '', lastName: tokens[0], needs: null, flag: 'single-token-name' };
  }

  // Three or more tokens: per-row confirmation, offering the split points as
  // clickable positions with a suggested default. The fixtures overturned the
  // original recommendation to refuse a combined column — only 3 of 63 first
  // names and 1 of 63 surnames contain an internal space, so the largest real
  // list needs about four confirmations, not sixty-three.
  const splitPoints = tokens.map((_, i) => i).slice(1);
  const suggested = nameOrder === 'last-first' ? 1 : tokens.length - 1;
  const at = (k) => ordered(tokens.slice(0, k).join(' '), tokens.slice(k).join(' '), nameOrder);

  // An answered split is a settled row: this is the only channel by which the
  // question below can come back, so without it #71 would have to re-implement
  // the splitting the module already emits split points for.
  if (splitPoints.includes(chosenSplit)) {
    return { ...at(chosenSplit), needs: null, flag: null };
  }

  return {
    ...at(suggested),
    needs: { kind: 'name-split', tokens, splitPoints, suggested },
    flag: 'name-split',
  };
}

// ---------------------------------------------------------------------------
// The parse
// ---------------------------------------------------------------------------

const REFUSALS = {
  'layout-not-held': 'The layout could not be established from the dates in this list.',
  'no-dob-column':
    'No column holds a date in every row, so the date of birth cannot be identified.',
  'dob-column-ambiguous':
    'More than one column holds a date in every row, so the date of birth is ambiguous.',
  'no-name-columns': 'No column holds names in every row.',
  'date-orientation-contradiction':
    'This list contains dates that prove both day/month and month/day, so it cannot be read '
    + 'safely.',
};

const refusal = (code, extra = {}) => ({ code, message: REFUSALS[code], ...extra });

/**
 * @param {string} text            the pasted list
 * @param {object} [options]
 * @param {'dmy'|'mdy'} [options.dateOrientation]  answer to the P11 question
 * @param {'first-last'|'last-first'} [options.nameOrder]  answer to the P7 question
 * @param {Object<number, number>} [options.nameSplits]  answers to the P8
 *        per-row question: first source line number → chosen split point
 * @param {string} [options.eventDate]  ISO date, enables the P13 age band
 *
 * Every question this module raises in `needs` has an option above that answers
 * it. Layout and column overrides deliberately do not: those are inferences
 * with a UI affordance rather than questions, and their shape belongs to #71.
 */
export function parseStudentList(text, options = {}) {
  const nameOrder = options.nameOrder === 'last-first' ? 'last-first' : 'first-last';
  const nameSplits = options.nameSplits ?? {};
  const lines = splitLines(text);
  const delimiter = detectDelimiter(lines);

  const ignored = [];
  const errors = [];

  const cells = lines.map((line) => ({ ...line, fields: splitFields(line.raw, delimiter) }));
  for (const cell of cells) {
    if (cell.fields.length === 0) {
      ignored.push({ lineNumbers: [cell.n], text: cell.raw, reason: 'blank' });
    }
  }
  const filled = cells.filter((c) => c.fields.length > 0);

  // A refusal re-buckets from scratch: every non-blank line becomes an error,
  // because nothing about the list was established. It cannot reuse `ignored`,
  // which by this point may already hold header lines that are also in
  // `filled` — counting those twice would break P1 on exactly the path where
  // the reconciliation matters most.
  const bail = (code, extra) =>
    finish({
      lines,
      layout: null,
      records: [],
      ignored: cells
        .filter((c) => c.fields.length === 0)
        .map((c) => ({ lineNumbers: [c.n], text: c.raw, reason: 'blank' })),
      errors: filled.map((c) => ({
        lineNumbers: [c.n],
        text: c.raw,
        reason: code,
      })),
      refusalValue: refusal(code, extra),
      extras: {},
    });

  if (filled.length === 0) {
    return finish({
      lines,
      layout: null,
      records: [],
      ignored,
      errors,
      refusalValue: null,
      extras: {},
    });
  }

  // --- layout ------------------------------------------------------------
  // The delimiter narrows the hypothesis; the modal field count decides it. A
  // list whose rows hold one field each cannot be one record per line whatever
  // its delimiter, so a vertical list carrying a single stray double-space is
  // still read as vertical rather than refused for having no name columns.
  const counts = new Map();
  for (const c of filled) counts.set(c.fields.length, (counts.get(c.fields.length) ?? 0) + 1);
  const modalWidth = modalCount([...counts.entries()]);
  const vertical = modalWidth === 1;

  let rows; // { fields, lineNumbers }
  let header = null;
  let width;
  let blockSize = null;

  if (vertical) {
    // Every line contributes its first field: in a vertical list that is the
    // whole line, and where a stray delimiter split one, the remainder is not
    // part of the repeating block.
    const seq = filled.map((c) => ({ value: c.fields[0], n: c.n }));
    const shape = detectVertical(seq, true) || detectVertical(seq, false);
    if (!shape) return bail('layout-not-held');

    blockSize = shape.blockSize;
    width = blockSize;
    rows = [];
    for (let b = 0; b < shape.blocks; b++) {
      const at = shape.start + b * blockSize;
      const block = seq.slice(at, at + blockSize);
      rows.push({ fields: block.map((c) => c.value), lineNumbers: block.map((c) => c.n) });
    }
    // Everything before the first block is header or junk; both are ignored,
    // and both are before the first record, so P9 never has to choose.
    const lead = seq.slice(0, shape.start);
    if (lead.length === blockSize) header = lead.map((c) => c.value);
    for (const cell of lead) {
      ignored.push({
        lineNumbers: [cell.n],
        text: cell.value,
        reason: header ? 'header' : 'junk',
      });
    }
    // A truncated final block cannot be a student; it is after the first good
    // record, so it is unparseable rather than junk.
    for (const cell of seq.slice(shape.start + shape.blocks * blockSize)) {
      errors.push({ lineNumbers: [cell.n], text: cell.value, reason: 'incomplete-block' });
    }
  } else {
    width = modalWidth;
    rows = filled
      .filter((c) => c.fields.length === width)
      .map((c) => ({ fields: c.fields, lineNumbers: [c.n], raw: c.raw }));
  }

  // --- the DOB anchor ----------------------------------------------------
  // Strict first, so a list that has a real date column is never anchored on a
  // five-digit integer column that happens to look like Excel serials.
  const dateBearing = (strict) =>
    rows.filter((row) => row.fields.some((f) => isDateShaped(f, { strict })));

  let strict = true;
  let dataRows = dateBearing(true);
  if (dataRows.length === 0) {
    strict = false;
    dataRows = dateBearing(false);
  }
  if (dataRows.length === 0) return bail('no-dob-column');

  const dateCols = [];
  for (let c = 0; c < width; c++) {
    if (dataRows.every((row) => isDateShaped(row.fields[c], { strict }))) dateCols.push(c);
  }
  if (dateCols.length === 0) return bail('no-dob-column');
  if (dateCols.length > 1) return bail('dob-column-ambiguous', { columns: dateCols });
  const dobCol = dateCols[0];

  // --- non-data lines, classified by position (P9) ------------------------
  if (!vertical) {
    const firstRecordLine = dataRows[0].lineNumbers[0];
    const dataLines = new Set(dataRows.map((r) => r.lineNumbers[0]));
    for (const cell of filled) {
      if (dataLines.has(cell.n)) continue;
      const before = cell.n < firstRecordLine;
      const hasDate = cell.fields.some((f) => isDateShaped(f, { strict }));
      if (before && !hasDate && cell.fields.length === width && header === null) {
        // A modal-width, date-free line before the first record names the
        // columns. It is not junk by P9's definition — its field count matches
        // — and it is the only line whose text this parser reads for meaning.
        header = cell.fields;
        ignored.push({ lineNumbers: [cell.n], text: cell.raw, reason: 'header' });
      } else if (before && !hasDate) {
        // Junk is defined by position: no date, and before the first good
        // record. The school title line and the stray prose sentence both
        // collapse to a single field; data rows do not.
        //
        // P9 also names a field count unlike the modal one, but that clause is
        // what separates junk from the *header* — which is caught above and
        // ignored under its own reason. Once the header is taken, a further
        // modal-width date-free line before the first record (a second header
        // from a merged export) is junk too: P9's protection is positional, and
        // nothing before the first good record can be a hidden student.
        ignored.push({ lineNumbers: [cell.n], text: cell.raw, reason: 'junk' });
      } else {
        // After the first good record, a line that does not parse is
        // unparseable, not junk. That is where a real student hides — it blocks
        // Apply until corrected or explicitly dismissed (P15).
        errors.push({ lineNumbers: [cell.n], text: cell.raw, reason: 'unparseable' });
      }
    }
  }

  // --- column mapping (P6) ------------------------------------------------
  const mapping = mapColumns(dataRows, width, dobCol, header);
  if (!mapping) return bail('no-name-columns');

  const usedCols = new Set(
    [dobCol, mapping.firstName, mapping.lastName, mapping.combined].filter(
      (c) => c !== null && c !== undefined
    )
  );
  const ignoredColumns = [];
  for (let c = 0; c < width; c++) {
    if (!usedCols.has(c)) ignoredColumns.push({ index: c, label: columnLabel(header, c) });
  }

  // --- date orientation, once for the whole list (P11) --------------------
  const evidence = new Map();
  for (const row of dataRows) {
    const verdict = orientationEvidence(row.fields[dobCol]);
    if (verdict && !evidence.has(verdict)) evidence.set(verdict, row);
  }

  let orientation = null;
  let orientationBasis;
  let orientationSample = null;

  if (evidence.size > 1) {
    // Contradictory evidence refuses the whole *paste*, and refusing has to
    // mean no rows. Falling through to the row loop here would let each
    // self-proving date be read on its own orientation — the row-by-row
    // decision P11 exists to forbid — and would hand the caller apply-ready
    // rows for a list the spec says cannot be read at all.
    return bail('date-orientation-contradiction', {
      rows: [...evidence.entries()].map(([reading, row]) => ({
        reading,
        value: row.fields[dobCol],
        lineNumbers: row.lineNumbers,
      })),
    });
  }

  if (evidence.size === 1) {
    orientation = [...evidence.keys()][0];
    orientationBasis = 'proved'; // a field above 12 is a proof, not a heuristic
  } else if (options.dateOrientation === 'dmy' || options.dateOrientation === 'mdy') {
    orientation = options.dateOrientation;
    orientationBasis = 'supplied';
  } else {
    const ambiguous = dataRows.find(
      (row) => readDate(row.fields[dobCol], null).error === 'needs-orientation'
    );
    if (ambiguous) {
      // Never default silently. A wrong orientation does not error — it turns
      // March into May, reports the student not-found, and creates a permanent
      // contact with a wrong DOB that poisons the identity key for every later
      // term. So ask, showing a real date from the paste read both ways.
      orientationBasis = 'ask';
      const value = ambiguous.fields[dobCol];
      orientationSample = {
        value,
        lineNumbers: ambiguous.lineNumbers,
        dmy: readDate(value, 'dmy').iso ?? null,
        mdy: readDate(value, 'mdy').iso ?? null,
      };
    } else {
      orientationBasis = 'self-identifying'; // every date is ISO or a serial
    }
  }

  // --- rows ---------------------------------------------------------------
  const listNeeds = [];
  if (!mapping.nameOrderKnown && !options.nameOrder) {
    const samples = dataRows.slice(0, 2).map((row) => ({
      values: mapping.combined === null
        ? [writeForm(row.fields[mapping.firstName]), writeForm(row.fields[mapping.lastName])]
        : [writeForm(row.fields[mapping.combined])],
      lineNumbers: row.lineNumbers,
    }));
    listNeeds.push({ kind: 'name-order', default: 'first-last', samples });
  }
  if (orientationBasis === 'ask') {
    listNeeds.push({ kind: 'date-orientation', sample: orientationSample });
  }

  let records = [];
  let sawComma = false;
  let sawSerial = false;

  for (const row of dataRows) {
    const rawDob = row.fields[dobCol];
    let rawFirst;
    let rawLast;
    let names;

    if (mapping.combined !== null) {
      // Splits are answered per row, keyed by the row's first source line —
      // the one identifier that survives a re-parse of the same paste.
      names = splitCombinedName(
        row.fields[mapping.combined],
        nameOrder,
        nameSplits[row.lineNumbers[0]]
      );
      rawFirst = row.fields[mapping.combined];
      rawLast = row.fields[mapping.combined];
      if (names.flag === 'comma-split') sawComma = true;
    } else {
      rawFirst = row.fields[mapping.firstName];
      rawLast = row.fields[mapping.lastName];
      names = {
        ...ordered(writeForm(rawFirst), writeForm(rawLast), nameOrder),
        needs: null,
        flag: null,
      };
    }

    const read = readDate(rawDob, orientation);
    if (read.error && read.error !== 'needs-orientation') {
      errors.push({ lineNumbers: row.lineNumbers, text: rawDob, reason: read.error });
      continue;
    }

    const flags = [];
    const needs = [];
    if (names.flag && names.flag !== 'comma-split') flags.push(names.flag);
    if (names.needs) needs.push(names.needs);
    if (read.kind === 'serial') {
      sawSerial = true;
      flags.push('excel-serial'); // P12 surfaces the resulting date for a sanity check
    }
    if (read.error === 'needs-orientation') needs.push({ kind: 'date-orientation' });

    const dob = read.iso ?? null;
    if (dob && Number(dob.slice(0, 4)) < 2000) {
      // Students are all born this century. A sharper teacher-row detector than
      // guessing at names — and a flag, not a block.
      flags.push('not-a-student');
    } else if (dob && options.eventDate) {
      const age = ageOn(dob, options.eventDate);
      if (age !== null && (age < MIN_PLAUSIBLE_AGE || age > MAX_PLAUSIBLE_AGE)) {
        flags.push('implausible-age');
      }
    }

    records.push({
      lineNumbers: [...row.lineNumbers],
      raw: { firstName: rawFirst, lastName: rawLast, dob: rawDob },
      write: { firstName: names.firstName, lastName: names.lastName, dob },
      compare: { firstName: compareForm(names.firstName), lastName: compareForm(names.lastName) },
      flags,
      needs,
      duplicateCount: 1, // raised by collapseDuplicates when a row absorbs another
      state: 'clean', // set below, once dedup has had its say
    });
  }

  if (sawComma) {
    // Confirmed once for the list, not per row.
    listNeeds.push({ kind: 'combined-name-comma' });
  }
  if (sawSerial) {
    listNeeds.push({ kind: 'excel-serial-dates' });
  }

  records = collapseDuplicates(records);
  for (const record of records) {
    const unsettled = record.needs.length > 0 || record.flags.length > 0;
    record.state = unsettled ? 'needs-confirmation' : 'clean';
  }

  const students = records.length;
  const plural = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  const shape = vertical
    ? `read as ${blockSize} fields per student`
    : `read as one student per line, ${plural(width, 'column')}`;
  const verdict = `${shape} — ${plural(students, 'student')} found`;

  return finish({
    lines,
    layout: vertical ? 'vertical' : 'horizontal',
    records,
    ignored,
    errors,
    refusalValue: null, // every refusal returns through bail() above
    extras: {
      blockSize,
      fieldCount: width,
      header,
      verdict,
      columns: {
        dob: dobCol,
        firstName: mapping.firstName,
        lastName: mapping.lastName,
        combined: mapping.combined,
        // Emitted so identity.js can weaken the first-name tie-breaker rather
        // than read a nickname mismatch as a wrong match.
        firstNameIsPreferred: mapping.firstNameIsPreferred,
      },
      ignoredColumns,
      dateOrientation: {
        value: orientation,
        basis: orientationBasis,
        sample: orientationSample,
      },
      nameOrder,
      needs: listNeeds,
    },
  });
}

// ---------------------------------------------------------------------------
// P14 — true duplicates collapse visibly; twins stay as two rows
// ---------------------------------------------------------------------------
// Collapsing on surname + DOB alone is rejected: it merges twins into one
// student, and nobody discovers the missing child until the session. Silent
// collapsing is not acceptable either — a school merging two class exports is
// exactly how a list gains a duplicate, and the badge is what makes it visible.

function collapseDuplicates(records) {
  const groups = new Map();
  for (const record of records) {
    if (!record.write.dob) continue;
    const key = `${record.compare.lastName}|${record.write.dob}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }

  const dropped = new Set();
  for (const group of groups.values()) {
    const byFirst = new Map();
    for (const record of group) {
      const first = record.compare.firstName;
      if (!byFirst.has(first)) byFirst.set(first, []);
      byFirst.get(first).push(record);
    }
    for (const same of byFirst.values()) {
      if (same.length < 2) continue;
      const [keep, ...rest] = same;
      for (const extra of rest) {
        keep.lineNumbers.push(...extra.lineNumbers);
        dropped.add(extra);
      }
      keep.lineNumbers.sort((a, b) => a - b);
      keep.flags.push('listed-twice');
      keep.duplicateCount = same.length;
    }
    if (byFirst.size > 1) {
      // Same surname and birthday, different first name: twins, and exactly the
      // case the first-name tie-breaker exists for. Both rows survive.
      for (const record of group) {
        if (!dropped.has(record)) record.flags.push('possible-siblings');
      }
    }
  }

  return records.filter((record) => !dropped.has(record));
}

// ---------------------------------------------------------------------------
// P1 — the reconciliation, checked here rather than left to the caller
// ---------------------------------------------------------------------------

function finish({ lines, layout, records, ignored, errors, refusalValue, extras }) {
  const recordLines = records.reduce((n, r) => n + r.lineNumbers.length, 0);
  const ignoredLines = ignored.reduce((n, e) => n + e.lineNumbers.length, 0);
  const errorLines = errors.reduce((n, e) => n + e.lineNumbers.length, 0);
  const accounted = recordLines + ignoredLines + errorLines;

  ignored.sort((a, b) => a.lineNumbers[0] - b.lineNumbers[0]);
  errors.sort((a, b) => a.lineNumbers[0] - b.lineNumbers[0]);

  return {
    layout,
    blockSize: null,
    fieldCount: null,
    header: null,
    verdict: '',
    columns: null,
    ignoredColumns: [],
    dateOrientation: null,
    nameOrder: 'first-last',
    needs: [],
    ...extras,
    records,
    ignored,
    errors,
    refusal: refusalValue ?? null,
    counts: {
      lines: lines.length,
      records: records.length,
      recordLines,
      ignored: ignored.length,
      ignoredLines,
      errors: errors.length,
      errorLines,
      accounted,
      reconciled: accounted === lines.length,
    },
  };
}
