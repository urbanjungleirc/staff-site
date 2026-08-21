// school-booking/steps.js
//
// The gates of steps 1–3 of the school booking page, as a pure module: the
// school tag, the count declaration (P5), and the review that decides whether
// step 3 may be left. No DOM, no network, no clock — the page imports this and
// publishes it as `window.schoolBookingSteps`, the seam delete-logic.js,
// unsubscribes-logic.js and nav-menu.js already use.
//
// §9 of docs/superpowers/specs/2026-08-19-school-group-booking-design.md, and
// #71. Parsing rules are parse.js (#64) and are not restated here; this module
// decides what the parse *means* for the run, which is a different question and
// the one the page's gates are made of.
//
// ---------------------------------------------------------------------------
// Why the gates live here and not in the markup
// ---------------------------------------------------------------------------
// The gate this page exists to enforce was defeated once already, by its own
// affordance: `x-show="b.fix"` in the #54 prototype ran the blocker's "confirm
// all" on every render tick, silently confirming rows nobody had confirmed,
// with no user action and no error (§16). A rendering fault, not a logic fault
// — which is exactly why the logic has to be somewhere a test can reach it, and
// why nothing this module returns is ever a function. There is no `fix` on a
// blocker here to be invoked by accident.
//
// ---------------------------------------------------------------------------
// The resolution log
// ---------------------------------------------------------------------------
// Staff edits are held as a separate layer rather than written back over the
// parse. Re-parsing is how the layout override, the column chips and the two
// list-level questions are answered, and each re-parse throws the previous
// result away — an edit stored inside it would go with it. The log is keyed by
// the row's **first source line number**, the one identifier that survives a
// re-parse of the same paste (parse.js keys its own `nameSplits` answers the
// same way), or by `list:<kind>` for a question about the whole list.

// The `?v=` is not decoration here and is not optional. A module specifier is
// a URL: `parse.js` and `parse.js?v=1` are two different modules to a browser,
// so an unversioned import here would (a) instantiate a second copy of the
// parser beside the page's, and (b) never be invalidated by bumping the page's
// `?v=` — leaving this module, which holds every gate, running against a
// cached parser the page has already moved on from. That is exactly the
// "breaks every check simultaneously and silently" failure §16 names.
//
// Bump this in lockstep with school-booking.html. alpine-bindings.test.js
// fails if the two ever disagree.
import { compareForm, readDate, writeForm } from './parse.js?v=1';

const DOMAIN = 'urbanjungleirc.com';

// ---------------------------------------------------------------------------
// Step 1 — the school tag
// ---------------------------------------------------------------------------
// The tag is the local part of `noreply+<tag>@urbanjungleirc.com`, the only
// provenance this system will ever have (§4, and schools.js). Months later it
// is the entire reason an operator resolving a duplicate can tell which school
// the other record belongs to, so it has to survive being typed, stored and
// searched for without changing shape.

/**
 * Normalise typed input to a tag. Lowercase letters and digits only: a tag with
 * a space or an apostrophe in it is a tag that will not partial-match itself
 * back out of Clubworx's email filter, which is how the picker finds the school
 * again next term.
 *
 * A tag that is already a tag comes back unchanged — the picker hands back tags
 * Clubworx already holds, and normalising one into a *different* tag would
 * write a second spelling of a school that already has one, permanently, on
 * contacts Clubworx cannot delete.
 */
export function schoolTag(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The permanent school marker, or null when there is no tag to make one from. */
export function schoolMarker(tag) {
  const clean = schoolTag(tag);
  return clean ? `noreply+${clean}@${DOMAIN}` : null;
}

// ---------------------------------------------------------------------------
// Step 2 — P5, the count declaration
// ---------------------------------------------------------------------------
// Staff declare the expected count *before* the parse result is shown. The
// order is the whole point: a count displayed first is anchoring theatre,
// because nobody disagrees with a number already on screen.

/**
 * Read what staff typed into a declaration. "I don't know" is a declaration
 * too, and it deliberately forgets any number typed before the box was ticked
 * — the banner and the gate are different outcomes, and carrying a stale number
 * into the banner would let it block something it was never asked about.
 *
 * @returns {{ready: boolean, unknown: boolean, count: number|null}}
 */
export function countDeclaration({ value, unknown } = {}) {
  if (unknown) return { ready: true, unknown: true, count: null };
  const text = String(value ?? '').trim();
  const count = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(count) || count < 1) return { ready: false, unknown: false, count: null };
  return { ready: true, unknown: false, count };
}

// ---------------------------------------------------------------------------
// The resolution log
// ---------------------------------------------------------------------------

/**
 * Record — or take back — one resolution. Returns a new log; the original is
 * left alone, because Alpine re-renders from the returned value and a mutated
 * original would make an undo unobservable.
 *
 * **Taking one back leaves a `reverted` entry rather than erasing the key.**
 * The row goes back to exactly where the parse put it — nothing downstream
 * treats `reverted` as a resolution — but the log still says the row was
 * worked on, and that is what the re-declare gate is a question about. Erasing
 * the key erases the evidence, and the gate then swings shut behind staff who
 * undo their own edit; see canRedeclare().
 *
 * @param {object} resolutions  the current log
 * @param {number|string} key   a row's first source line, or `list:<kind>`
 * @param {object|null} action  `{kind: 'dismiss'|'accept'|'confirm'|'acknowledge', ...}`
 *                              or null to take the resolution back
 */
export function resolve(resolutions, key, action) {
  const next = { ...(resolutions ?? {}) };
  if (action === null || action === undefined) {
    const previous = next[key];
    // Nothing to take back means nothing to remember.
    if (!previous) delete next[key];
    else next[key] = { kind: 'reverted', was: previous.was ?? previous.kind };
  } else {
    next[key] = action;
  }
  return next;
}

// ---------------------------------------------------------------------------
// Step 3 — the review
// ---------------------------------------------------------------------------

// Why a row wants a human, in the words staff would use. Every flag and need
// parse.js can raise has a line here: a row that blocks the run without saying
// why is a row that gets dismissed to make the blocker go away.
const NOTES = {
  'name-split': 'Three or more name parts — check where the surname starts.',
  'excel-serial': 'The date arrived as a spreadsheet serial number. Check it reads right.',
  'implausible-age': 'That birthday is outside the age range a school session normally has.',
  'not-a-student': 'Born before 2000 — this is probably a teacher, not a student.',
  'listed-twice': 'Listed twice in the paste. Collapsed to one student.',
  'possible-siblings': 'Shares a surname and birthday with another row — twins, or one child twice.',
  'empty-name': 'No name on this line.',
  'date-orientation': 'This date could be day/month or month/day.',
};

const REASON_NOTES = {
  unparseable: 'Sits after real students, so it may be one. Nothing runs until it is accounted for.',
  'incomplete-block': 'A part-finished student at the end of the paste.',
  'needs-orientation': 'This date could be day/month or month/day.',
};

const plural = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;

const noteFor = (flags, needs, fallback) => {
  for (const flag of flags) if (NOTES[flag]) return NOTES[flag];
  for (const need of needs) if (NOTES[need.kind]) return NOTES[need.kind];
  return fallback ?? '';
};

const nameOf = (row) => [row.firstName, row.lastName].filter(Boolean).join(' ').trim();

// The resolution actually in force on a row. `reverted` is a record of what
// staff did, not a state the row is in.
const inForce = (entry) => (!entry || entry.kind === 'reverted' ? null : entry.kind);

// Did staff work the rows themselves? The question the re-declare gate asks,
// answered over the whole log rather than over the current counts — including
// entries since taken back, because taking an edit back does not un-read the
// list. Confirming is left out on purpose: it is agreeing with the parser
// about a row, which tells nobody anything new about how many students there
// are. Acknowledging a list-level question is not about a row at all.
const EDIT_KINDS = ['accept', 'dismiss'];
const rowsWorked = (log) =>
  Object.entries(log).some(([key, entry]) =>
    !String(key).startsWith('list:') && EDIT_KINDS.includes(entry.was ?? entry.kind));

// A record built out of a line staff accepted as a student. It is deliberately
// the same shape as one parse.js emits, down to `compare` — the identity read
// in step 4 must not be able to tell an accepted row from a parsed one, or the
// row that most needed a human would be the one that skipped the matching.
function acceptedRecord(error, action, orientation) {
  const firstName = writeForm(action.firstName);
  const lastName = writeForm(action.lastName);
  if (!firstName || !lastName) return null;

  const read = readDate(action.dob, orientation);
  if (read.error || !read.iso) return null;

  return {
    lineNumbers: [...error.lineNumbers],
    raw: { firstName: action.firstName, lastName: action.lastName, dob: action.dob },
    write: { firstName, lastName, dob: read.iso },
    compare: { firstName: compareForm(firstName), lastName: compareForm(lastName) },
    flags: [],
    needs: [],
    duplicateCount: 1,
    state: 'clean',
    accepted: true,
  };
}

/**
 * Everything step 3 shows, and everything it blocks on, from one call.
 *
 * @param {object} parsed  a parseStudentList result
 * @param {object} context
 * @param {object} context.declaration  a countDeclaration
 * @param {object} context.resolutions  the resolution log
 */
export function review(parsed, { declaration, resolutions } = {}) {
  const log = resolutions ?? {};
  const gate = declaration ?? { ready: false, unknown: false, count: null };
  const blockers = [];

  if (!parsed) {
    return {
      rows: [], ignored: [], blockers: [], ready: false, reconciled: true,
      declared: gate, recordsParsed: 0,
      counts: { lines: 0, records: 0, recordLines: 0, ignored: 0, ignoredLines: 0, errors: 0, errorLines: 0, accounted: 0 },
    };
  }

  // A refused paste blocks with the refusal alone. bail() re-buckets every
  // non-blank line as an error, so listing those as well would bury the one
  // sentence that says what is actually wrong under a wall of rows that are
  // only errors because the list could not be read at all.
  if (parsed.refusal) {
    return {
      rows: [],
      ignored: parsed.ignored,
      blockers: [{
        key: 'refusal',
        kind: 'refusal',
        severity: 'block',
        title: 'This list cannot be read safely',
        detail: parsed.refusal.message,
        lineNumbers: [],
        actions: [],
      }],
      ready: false,
      reconciled: parsed.counts.reconciled,
      declared: gate,
      recordsParsed: 0,
      counts: parsed.counts,
    };
  }

  const orientation = parsed.dateOrientation?.value ?? null;

  // --- resolutions applied, bucket by bucket ------------------------------
  const records = [];
  const ignored = parsed.ignored.map((entry) => ({ ...entry }));
  const errors = [];

  for (const record of parsed.records) {
    const action = log[record.lineNumbers[0]];
    if (action?.kind === 'dismiss') {
      ignored.push({
        lineNumbers: [...record.lineNumbers],
        text: nameOf(record.write) || record.raw.firstName,
        reason: 'dismissed',
      });
      continue;
    }
    if (action?.kind === 'confirm') {
      const firstName = writeForm(action.firstName ?? record.write.firstName);
      const lastName = writeForm(action.lastName ?? record.write.lastName);
      records.push({
        ...record,
        write: { ...record.write, firstName, lastName },
        compare: { firstName: compareForm(firstName), lastName: compareForm(lastName) },
        state: 'clean',
        confirmed: true,
      });
      continue;
    }
    records.push(record);
  }

  for (const error of parsed.errors) {
    const key = error.lineNumbers[0];
    const action = log[key];
    if (action?.kind === 'dismiss') {
      ignored.push({ lineNumbers: [...error.lineNumbers], text: error.text, reason: 'dismissed' });
      continue;
    }
    if (action?.kind === 'accept') {
      // An acceptance that will not read is not an acceptance. Taking it
      // anyway writes a permanent contact with a wrong or missing date of
      // birth, which then poisons the surname + DOB identity key for every
      // later term — so the row stays exactly where it was, still blocking.
      const record = acceptedRecord(error, action, orientation);
      if (record) {
        records.push(record);
        continue;
      }
    }
    errors.push(error);
  }

  records.sort((a, b) => a.lineNumbers[0] - b.lineNumbers[0]);
  ignored.sort((a, b) => a.lineNumbers[0] - b.lineNumbers[0]);
  errors.sort((a, b) => a.lineNumbers[0] - b.lineNumbers[0]);

  // --- P1, re-asserted after the resolutions, not only after the parse ----
  const sum = (entries) => entries.reduce((n, e) => n + e.lineNumbers.length, 0);
  const recordLines = sum(records);
  const ignoredLines = sum(ignored);
  const errorLines = sum(errors);
  const accounted = recordLines + ignoredLines + errorLines;
  const counts = {
    lines: parsed.counts.lines,
    records: records.length,
    recordLines,
    ignored: ignored.length,
    ignoredLines,
    errors: errors.length,
    errorLines,
    accounted,
    reconciled: accounted === parsed.counts.lines,
  };

  // --- the rows on screen -------------------------------------------------
  const rows = [
    ...records.map((record) => ({
      key: record.lineNumbers[0],
      lineNumbers: [...record.lineNumbers],
      bucket: 'record',
      state: record.state,
      firstName: record.write.firstName,
      lastName: record.write.lastName,
      dob: record.write.dob,
      raw: '',
      flags: [...record.flags],
      needs: record.needs.map((need) => ({ ...need })),
      note: record.state === 'clean' ? '' : noteFor(record.flags, record.needs),
      needsHuman: record.state !== 'clean',
      resolution: inForce(log[record.lineNumbers[0]]),
    })),
    ...errors.map((error) => ({
      key: error.lineNumbers[0],
      lineNumbers: [...error.lineNumbers],
      bucket: 'error',
      state: 'error',
      firstName: '',
      lastName: '',
      dob: null,
      raw: error.text,
      flags: [],
      needs: [],
      note: REASON_NOTES[error.reason] ?? REASON_NOTES.unparseable,
      needsHuman: true,
      resolution: inForce(log[error.lineNumbers[0]]),
    })),
  ].sort((a, b) => a.key - b.key);

  // --- what blocks --------------------------------------------------------
  if (!counts.reconciled) {
    // P1 applied literally. If this ever fires the run must not start: a line
    // that is in no bucket is a student nobody can see.
    blockers.push({
      key: 'reconciliation',
      kind: 'reconciliation',
      severity: 'block',
      title: 'The line counts do not add up',
      detail: `${counts.accounted} of ${counts.lines} pasted lines are accounted for.`,
      lineNumbers: [],
      actions: [],
    });
  }

  if (gate.unknown) {
    blockers.push({
      key: 'count-unknown',
      kind: 'count-unknown',
      severity: 'warn',
      title: `We read ${plural(counts.records, 'student')}`,
      detail: 'Nobody has said how many there should be, so nothing is checking this number.',
      lineNumbers: [],
      actions: [],
    });
  } else if (gate.ready && gate.count !== counts.records) {
    blockers.push({
      key: 'count-mismatch',
      kind: 'count-mismatch',
      severity: 'block',
      title: `You expected ${gate.count}; we read ${counts.records}`,
      detail: 'A layout read wrong, a header absorbed as a student or a truncated paste all '
        + 'look like this. Fix the rows, or say the count has changed.',
      lineNumbers: [],
      // The escape hatch, offered only when the gate survives it — see
      // canRedeclare() below. Carried as data so the markup cannot offer it
      // ungated by forgetting a condition.
      actions: rowsWorked(log)
        ? [{
          key: 'redeclare',
          label: `The count has changed \u2014 make it ${counts.records}`,
          answers: 'redeclare',
          value: counts.records,
        }]
        : [],
    });
  }

  const unreadable = rows.filter((row) => row.bucket === 'error');
  if (unreadable.length > 0) {
    blockers.push({
      key: 'unparseable-rows',
      kind: 'unparseable-rows',
      severity: 'block',
      title: `${plural(unreadable.length, 'line')} could not be read`,
      detail: 'Each sits after a real student, so each may be one. Give it a name and a '
        + 'birthday, or say it is not a student.',
      lineNumbers: unreadable.flatMap((row) => row.lineNumbers),
      actions: [],
    });
  }

  const wanting = rows.filter((row) => row.bucket === 'record' && row.needsHuman);
  if (wanting.length > 0) {
    blockers.push({
      key: 'needs-confirmation',
      kind: 'needs-confirmation',
      severity: 'block',
      title: `${plural(wanting.length, 'row')} needs you`,
      detail: wanting.map((row) => nameOf(row) || `line ${row.key}`).join(', '),
      lineNumbers: wanting.flatMap((row) => row.lineNumbers),
      actions: [],
    });
  }

  for (const need of parsed.needs) {
    // Two of these are answered by re-parsing — the page holds the answer and
    // passes it back to parse.js, so the blocker disappears on its own. The
    // other two have no parse option to answer: they are confirmations, and
    // the log is where a confirmation goes.
    const acknowledged = log[`list:${need.kind}`]?.kind === 'acknowledge';
    if (acknowledged) continue;
    blockers.push(listBlocker(need, parsed));
  }

  return {
    rows,
    ignored,
    counts,
    // The list-level inferences, carried through unchanged. §7 P2 is explicit
    // that the dangerous decisions here are list-level rather than row-level,
    // and a page that cannot see them cannot show, confirm or override them.
    layout: parsed.layout,
    blockSize: parsed.blockSize,
    fieldCount: parsed.fieldCount,
    header: parsed.header,
    verdict: parsed.verdict,
    columns: parsed.columns,
    ignoredColumns: parsed.ignoredColumns,
    // Which columns hold a name in every row. The chips need it to move a
    // combined name back onto two columns without guessing which one.
    nameShapedColumns: parsed.nameShapedColumns,
    dateOrientation: parsed.dateOrientation,
    nameOrder: parsed.nameOrder,
    reconciled: counts.reconciled,
    blockers,
    ready: !blockers.some((b) => b.severity === 'block'),
    declared: gate,
    // What the parser read before anybody touched it, and whether anybody has.
    recordsParsed: parsed.counts.records,
    rowsWorked: rowsWorked(log),
  };
}

function listBlocker(need, parsed) {
  const base = {
    key: `list:${need.kind}`, kind: need.kind, severity: 'block', lineNumbers: [], actions: [],
  };
  if (need.kind === 'name-order') {
    // Both readings, side by side. P7 asks for the samples "read both ways" and
    // the reason is the whole rule: shown in list order alone, staff reverse it
    // in their heads, which is the guess this exists to remove. A reversed
    // contact is permanent and nothing downstream would notice.
    const shown = (need.samples ?? [])
      .map((sample) => {
        const values = sample.values ?? [];
        const forward = values.join(' ');
        const reversed = [...values].reverse().join(' ');
        return forward === reversed ? forward : `${forward} / ${reversed}`;
      })
      .join(' · ');
    return {
      ...base,
      title: 'Which way round are the names?',
      detail: 'No header names the columns, so this is a guess. First-name-first, then '
        + `surname-first: ${shown}. Getting it wrong creates a permanently reversed contact `
        + 'and nothing downstream would notice.',
      actions: [
        { key: 'first-last', label: 'First name first', answers: 'nameOrder', value: 'first-last' },
        { key: 'last-first', label: 'Surname first', answers: 'nameOrder', value: 'last-first' },
      ],
    };
  }
  if (need.kind === 'date-orientation') {
    const sample = need.sample ?? {};
    return {
      ...base,
      title: 'Day/month, or month/day?',
      detail: `${sample.value} reads as ${sample.dmy} one way and ${sample.mdy} the other. `
        + 'A wrong reading does not error — it turns March into May.',
      actions: [
        { key: 'dmy', label: 'Day/month', answers: 'dateOrientation', value: 'dmy' },
        { key: 'mdy', label: 'Month/day', answers: 'dateOrientation', value: 'mdy' },
      ],
    };
  }
  if (need.kind === 'combined-name-comma') {
    return {
      ...base,
      title: 'A name was split on a comma',
      detail: 'Read as \u201CSurname, Given\u201D. Check the students below read the right way round.',
      actions: [acknowledgement(need.kind)],
    };
  }
  if (need.kind === 'excel-serial-dates') {
    return {
      ...base,
      title: 'Some dates arrived as spreadsheet serial numbers',
      detail: 'They have been converted. Check the birthdays below before going on.',
      actions: [acknowledgement(need.kind)],
    };
  }
  return { ...base, title: 'This list needs a decision', detail: need.kind };
}

// An action is data, like everything else a blocker carries: what to call it,
// and what answering it means. The page reads `answers` and dispatches; it does
// not know the blocker kinds, so a kind added here cannot arrive without the
// control that clears it. Nothing here is ever a function — see the header.
const acknowledgement = (kind) => ({
  key: `acknowledge:${kind}`,
  label: 'Checked \u2014 go on',
  answers: 'acknowledge',
  value: kind,
});

/**
 * Whether the count mismatch may offer a re-declare.
 *
 * Accepting an unreadable line as a student legitimately moves the count, so
 * the mismatch has to be re-answerable — but **only once staff have edited
 * rows themselves.** Ungated, that button is a one-click dismissal of the gate
 * P5 exists to enforce: staff who cannot make the numbers agree would agree
 * with the parser instead, which is the anchoring the gate's ordering was
 * designed to prevent. The gate must survive its own escape hatch.
 *
 * The question is whether staff **worked the rows**, not where the count
 * currently sits. Two things go wrong when it is tied to the count instead,
 * and both were found in use:
 *
 *   - **It swings shut behind an undo.** Dismiss a row, re-declare to the new
 *     number, then realise the dismissal was wrong and put the row back: the
 *     count matches the parse again, the button disappears, and the mismatch
 *     staff are now stuck on has no way out but re-pasting the whole list.
 *   - **It rewards dismissing a real student.** Staff who have read the rows
 *     and concluded the list really is what the parser said cannot unlock the
 *     button without moving the count — so the only route forward is to drop
 *     a child who belongs there.
 *
 * Confirming a row is still not an edit: it is agreeing with the parser about
 * one row, which says nothing new about how many students there are.
 */
export function canRedeclare(reviewed) {
  return Boolean(reviewed) && reviewed.rowsWorked === true;
}

// ---------------------------------------------------------------------------
// The lines step 3 puts on screen
// ---------------------------------------------------------------------------

/**
 * The ignored columns, named. That line costs nothing and is the tell that the
 * mapping went wrong (P6) — a column called `Email` sitting in the ignored list
 * is fine, and one called `Surname` sitting there is the whole story.
 */
export function ignoredColumnsLine(reviewed) {
  const columns = reviewed?.ignoredColumns;
  if (!columns || columns.length === 0) return '';
  return `${plural(columns.length, 'column')} ignored: ${columns.map((c) => c.label).join(', ')}.`;
}

/**
 * The ignored count, which is always on screen while the lines themselves stay
 * in a collapsed drawer (P9). Dismissals are counted apart from the rest: they
 * are the lines staff put there, and folding them into the same number would
 * hide a mis-click behind a header count nobody reads twice.
 */
export function ignoredSummary(reviewed) {
  const entries = reviewed?.ignored ?? [];
  const lines = (predicate) =>
    entries.filter(predicate).reduce((n, e) => n + e.lineNumbers.length, 0);
  const dismissed = lines((e) => e.reason === 'dismissed');
  const rest = lines((e) => e.reason !== 'dismissed');

  if (dismissed === 0 && rest === 0) return 'No lines ignored';
  if (dismissed === 0) return `${plural(rest, 'line')} ignored before the first student`;
  if (rest === 0) return `${plural(dismissed, 'line')} ignored, all dismissed by you`;
  return `${plural(rest + dismissed, 'line')} ignored — ${rest} before the first student, `
    + `${dismissed} you dismissed`;
}

/**
 * P1, as a sentence. It is a sum, so it has to add up on screen — which means
 * counting the students' **lines**, not the students. A vertical list puts one
 * student on six lines and a collapsed duplicate (P14) puts one on two, so
 * `5 + 7 + 0 = 37` is not arithmetic anybody can check; it is the reconciliation
 * failing quietly on the one screen whose job is making counts agree.
 *
 * The student count still leads, because that is the number staff came for. The
 * line count joins it only where the two differ.
 */
export function reconciliationLine(reviewed) {
  const c = reviewed?.counts;
  if (!c) return '';
  const students = c.recordLines === c.records
    ? plural(c.records, 'student')
    : `${plural(c.records, 'student')} on ${plural(c.recordLines, 'line')}`;
  return `${students} + ${c.ignoredLines} ignored + ${c.errorLines} unreadable `
    + `= ${plural(c.lines, 'line')} pasted.`;
}

/** The count gate, in the order it was asked: expected first, then read. */
export function countLine(reviewed) {
  const c = reviewed?.counts;
  if (!c) return '';
  const gate = reviewed.declared ?? {};
  if (gate.unknown) {
    return `We read ${plural(c.records, 'student')}. Nobody has said how many there should be.`;
  }
  if (!gate.ready) return `We read ${plural(c.records, 'student')}.`;
  return `You expected ${plural(gate.count, 'student')}; we read ${c.records}.`;
}
