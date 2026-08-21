// The gates of steps 1–3, tested at the seam the page cannot reach around.
//
// Every check the page enforces lives in steps.js, so the tests below are the
// gates themselves rather than a model of them: the count gate (P5), the
// reconciliation after a dismissal (P1), the re-declare that must not become a
// one-click dismissal of the gate it escapes, and the blocker list that decides
// whether step 3 may be left at all.
//
// Blockers are asserted to be pure data as well as correct. That is the
// structural half of the guard #78 asked for — the rendering half reads the
// page markup in alpine-bindings.test.js. A blocker carrying a function is what
// makes `x-show="b.fix"` possible in the first place.

import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseStudentList } from '../parse.js';
import {
  canRedeclare,
  countDeclaration,
  countLine,
  ignoredColumnsLine,
  ignoredSummary,
  reconciliationLine,
  resolve,
  review,
  schoolMarker,
  schoolTag,
} from '../steps.js';

const fixture = (name) =>
  readFileSync(new URL(`../../docs/school-lists/${name}`, import.meta.url), 'utf8');

const SPREADSHEET = fixture('fixture-2-spreadsheet.tsv'); // 6 students, headed, 3 columns
const VERTICAL = fixture('fixture-1-vertical.txt'); // 5 students, 6 fields each

const declared = (n) => countDeclaration({ value: n, unknown: false });
const unknown = () => countDeclaration({ value: '', unknown: true });

const reviewOf = (text, count, resolutions = {}, options = {}) =>
  review(parseStudentList(text, options), { declaration: count, resolutions });

// ---------------------------------------------------------------------------
// Step 1 — the school tag
// ---------------------------------------------------------------------------

describe('step 1 — the school tag', () => {
  test('a typed school becomes a tag safe to put in an address', () => {
    expect(schoolTag('  Example Grammar College ')).toBe('examplegrammarcollege');
    expect(schoolTag("St Mary's (Senior)")).toBe('stmaryssenior');
    expect(schoolTag('Newman JHS')).toBe('newmanjhs');
  });

  test('a tag that survives normalisation unchanged is left alone', () => {
    // The picker hands back tags Clubworx already holds. Normalising one into a
    // *different* tag would write a second spelling of a school that already
    // has one, on contacts that cannot be deleted.
    expect(schoolTag('newman')).toBe('newman');
    expect(schoolTag('stmarys')).toBe('stmarys');
  });

  test('nothing usable is left as an empty tag, never a partial one', () => {
    expect(schoolTag('')).toBe('');
    expect(schoolTag('   ')).toBe('');
    expect(schoolTag('—')).toBe('');
  });

  test('the marker is the only provenance this system will ever have', () => {
    expect(schoolMarker('newman')).toBe('noreply+newman@urbanjungleirc.com');
    expect(schoolMarker('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Step 2 — P5, the count gate
// ---------------------------------------------------------------------------

describe('step 2 — declaring the count', () => {
  test('a whole positive number is a declaration', () => {
    expect(declared('21')).toMatchObject({ ready: true, count: 21, unknown: false });
    expect(declared(21)).toMatchObject({ ready: true, count: 21 });
  });

  test('"I don\'t know" is a declaration too, and forgets any number typed first', () => {
    // The banner and the gate are different outcomes; carrying a stale number
    // into the banner would let it block something it was never asked about.
    expect(countDeclaration({ value: '21', unknown: true })).toMatchObject({
      ready: true,
      unknown: true,
      count: null,
    });
  });

  test('nothing, zero and nonsense are not declarations', () => {
    expect(declared('').ready).toBe(false);
    expect(declared('0').ready).toBe(false);
    expect(declared('-3').ready).toBe(false);
    expect(declared('twenty').ready).toBe(false);
    expect(declared('21.5').ready).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Step 3 — the review, and what blocks
// ---------------------------------------------------------------------------

describe('step 3 — the count gate blocks, or downgrades to a banner', () => {
  test('a matching count clears the gate', () => {
    const r = reviewOf(SPREADSHEET, declared(6));
    expect(r.counts.records).toBe(6);
    expect(r.blockers.filter((b) => b.kind === 'count-mismatch')).toHaveLength(0);
    expect(countLine(r)).toContain('6');
  });

  test('a mismatch blocks the run', () => {
    const r = reviewOf(SPREADSHEET, declared(21));
    const blocker = r.blockers.find((b) => b.kind === 'count-mismatch');
    expect(blocker).toBeDefined();
    expect(blocker.severity).toBe('block');
    expect(r.ready).toBe(false);
  });

  test('"I don\'t know" downgrades the gate to a banner that does not block', () => {
    const r = reviewOf(SPREADSHEET, unknown());
    const banner = r.blockers.find((b) => b.kind === 'count-unknown');
    expect(banner).toBeDefined();
    expect(banner.severity).toBe('warn');
    expect(r.blockers.some((b) => b.kind === 'count-mismatch')).toBe(false);
    expect(r.ready).toBe(true);
  });

  test('every blocker is data — no property is a function', () => {
    // #78. Alpine invokes a function returned by a directive expression, so a
    // blocker carrying `fix` is a gate that defeats itself on every render
    // tick. The fix is that there is nothing here to invoke.
    const r = reviewOf(SPREADSHEET, declared(21));
    expect(r.blockers.length).toBeGreaterThan(0);
    for (const blocker of r.blockers) {
      for (const [key, value] of Object.entries(blocker)) {
        expect(typeof value, `blockers[].${key}`).not.toBe('function');
      }
    }
  });
});

describe('step 3 — what the parse itself blocks on', () => {
  const WITH_STRAY_LINE = [
    ['First name', 'Surname', 'DOB'].join('\t'),
    ['Katie', 'Fernsby', '23/4/2010'].join('\t'),
    ['Tomas', 'Oakhill', '7/11/2010'].join('\t'),
    'and Otto if there is room',
  ].join('\n');

  test('an unparseable line blocks Apply until it is accounted for (P15)', () => {
    const r = reviewOf(WITH_STRAY_LINE, declared(2));
    const blocker = r.blockers.find((b) => b.kind === 'unparseable-rows');
    expect(blocker).toBeDefined();
    expect(blocker.severity).toBe('block');
    expect(blocker.lineNumbers).toEqual([4]);
    expect(r.ready).toBe(false);
  });

  test('a row wanting confirmation blocks, and names itself', () => {
    const headerless = [
      ['Katie', 'Fernsby', '23/4/2010'].join('\t'),
      ['Tomas', 'Oakhill', '7/11/2010'].join('\t'),
    ].join('\n');
    const r = reviewOf(headerless, declared(2));
    // A headerless list cannot know its name order, which is a question about
    // the list rather than a row — so it blocks as one.
    expect(r.blockers.some((b) => b.kind === 'name-order')).toBe(true);
    expect(r.ready).toBe(false);
  });

  test('a refused paste blocks with the refusal, not with a wall of row errors', () => {
    const twoDateColumns = [
      ['Katie', 'Fernsby', '23/4/2010', '1/2/2024'].join('\t'),
      ['Tomas', 'Oakhill', '7/11/2010', '3/3/2024'].join('\t'),
    ].join('\n');
    const r = reviewOf(twoDateColumns, declared(2));
    const blocker = r.blockers.find((b) => b.kind === 'refusal');
    expect(blocker).toBeDefined();
    expect(blocker.detail).toContain('ambiguous');
    expect(r.rows).toHaveLength(0);
    expect(r.ready).toBe(false);
  });

  test('the reconciliation is reported, not assumed', () => {
    const r = reviewOf(VERTICAL, declared(5));
    expect(r.reconciled).toBe(true);
    expect(reconciliationLine(r)).toMatch(/5 students/);
    expect(r.counts.accounted).toBe(r.counts.lines);
  });
});

// ---------------------------------------------------------------------------
// Inline resolution — the two rules that constrain it
// ---------------------------------------------------------------------------

describe('dismissing a row reclassifies it; it is never removed', () => {
  const WITH_STRAY_LINE = [
    ['First name', 'Surname', 'DOB'].join('\t'),
    ['Katie', 'Fernsby', '23/4/2010'].join('\t'),
    'and Otto if there is room',
  ].join('\n');

  test('a dismissed unreadable line moves to ignored and stops blocking', () => {
    const resolutions = resolve({}, 3, { kind: 'dismiss' });
    const r = reviewOf(WITH_STRAY_LINE, declared(1), resolutions);
    expect(r.blockers.some((b) => b.kind === 'unparseable-rows')).toBe(false);
    expect(r.ignored.some((i) => i.lineNumbers.includes(3) && i.reason === 'dismissed')).toBe(true);
    expect(r.ready).toBe(true);
  });

  test('the reconciliation is asserted after the dismissal, not only after the parse', () => {
    const resolutions = resolve({}, 3, { kind: 'dismiss' });
    const r = reviewOf(WITH_STRAY_LINE, declared(1), resolutions);
    expect(r.counts.accounted).toBe(r.counts.lines);
    expect(r.reconciled).toBe(true);
    // The line is still counted. Dropping it is what breaks P1, and the count
    // that catches that is the one on screen.
    expect(r.counts.ignoredLines).toBe(2); // the header, and the dismissed line
  });

  test('dismissing a student drops the record count, and P1 still holds', () => {
    const r = reviewOf(SPREADSHEET, declared(6), resolve({}, 2, { kind: 'dismiss' }));
    expect(r.counts.records).toBe(5);
    expect(r.reconciled).toBe(true);
    expect(r.counts.accounted).toBe(r.counts.lines);
  });

  test('a dismissal can be taken back', () => {
    const dismissed = resolve({}, 2, { kind: 'dismiss' });
    const restored = resolve(dismissed, 2, null);
    expect(reviewOf(SPREADSHEET, declared(6), restored).counts.records).toBe(6);
    // resolve() does not mutate what it is given — Alpine re-renders from the
    // returned value, and a mutated original would make undo unobservable.
    expect(reviewOf(SPREADSHEET, declared(6), dismissed).counts.records).toBe(5);
  });
});

describe('accepting an unreadable line as a student', () => {
  const WITH_STRAY_LINE = [
    ['First name', 'Surname', 'DOB'].join('\t'),
    ['Katie', 'Fernsby', '23/4/2010'].join('\t'),
    'Otto Brennan born 4 March 2011',
  ].join('\n');

  const accepted = resolve({}, 3, {
    kind: 'accept',
    firstName: 'Otto',
    lastName: 'Brennan',
    dob: '4/3/2011',
  });

  test('the line becomes a student, read on the list\'s own date orientation', () => {
    const r = reviewOf(WITH_STRAY_LINE, declared(1), accepted);
    expect(r.counts.records).toBe(2);
    const otto = r.rows.find((row) => row.key === 3);
    expect(otto).toMatchObject({ bucket: 'record', state: 'clean', firstName: 'Otto', lastName: 'Brennan' });
    expect(otto.dob).toBe('2011-03-04'); // dmy, proved by 23/4/2010 above
    expect(r.reconciled).toBe(true);
  });

  test('a date that will not read leaves the row unaccounted for', () => {
    // Silently accepting an unreadable date writes a permanent contact with a
    // wrong or missing DOB, which then poisons the surname + DOB key for every
    // later term. The row stays where it was.
    const bad = resolve({}, 3, { kind: 'accept', firstName: 'Otto', lastName: 'Brennan', dob: 'march' });
    const r = reviewOf(WITH_STRAY_LINE, declared(1), bad);
    expect(r.counts.records).toBe(1);
    expect(r.rows.find((row) => row.key === 3).bucket).toBe('error');
    expect(r.ready).toBe(false);
  });

  test('a half-filled acceptance is not an acceptance', () => {
    const half = resolve({}, 3, { kind: 'accept', firstName: 'Otto', lastName: '', dob: '4/3/2011' });
    const r = reviewOf(WITH_STRAY_LINE, declared(1), half);
    expect(r.counts.records).toBe(1);
    expect(r.ready).toBe(false);
  });
});

describe('the re-declare escape hatch, and the gate surviving it', () => {
  const WITH_STRAY_LINE = [
    ['First name', 'Surname', 'DOB'].join('\t'),
    ['Katie', 'Fernsby', '23/4/2010'].join('\t'),
    'Otto Brennan born 4 March 2011',
  ].join('\n');

  test('a plain mismatch offers no re-declare', () => {
    // Ungated this button is a one-click dismissal of the gate P5 exists to
    // enforce: staff who cannot make the numbers agree would simply agree with
    // the parser instead.
    const r = reviewOf(SPREADSHEET, declared(21));
    expect(r.blockers.some((b) => b.kind === 'count-mismatch')).toBe(true);
    expect(canRedeclare(r)).toBe(false);
  });

  test('accepting a line moves the count for a reason staff created, so it unlocks', () => {
    const accepted = resolve({}, 3, {
      kind: 'accept', firstName: 'Otto', lastName: 'Brennan', dob: '4/3/2011',
    });
    const r = reviewOf(WITH_STRAY_LINE, declared(1), accepted);
    expect(r.counts.records).toBe(2);
    expect(canRedeclare(r)).toBe(true);
  });

  test('dismissing a student unlocks it too — the number moved either way', () => {
    const r = reviewOf(SPREADSHEET, declared(6), resolve({}, 2, { kind: 'dismiss' }));
    expect(canRedeclare(r)).toBe(true);
  });

  test('confirming a row does not unlock it — nothing about the count changed', () => {
    const headerless = [
      ['Katie Fernsby van Aalst', 'HARLOW', '23/4/2010'].join('\t'),
      ['Tomas Oakhill', 'HARLOW', '7/11/2010'].join('\t'),
    ].join('\n');
    const withoutConfirm = reviewOf(headerless, declared(9), {}, { columns: { combined: 0 } });
    const confirmed = reviewOf(
      headerless,
      declared(9),
      resolve({}, 1, { kind: 'confirm' }),
      { columns: { combined: 0 } },
    );
    expect(confirmed.counts.records).toBe(withoutConfirm.counts.records);
    expect(canRedeclare(confirmed)).toBe(false);
  });

  test('dismissing an unreadable line does not unlock it either', () => {
    // It moves a line from `errors` to `ignored`. Nobody was ever asked to
    // count either bucket, so the declared number has no reason to move.
    const dismissed = resolve({}, 3, { kind: 'dismiss' });
    const r = reviewOf(WITH_STRAY_LINE, declared(1), dismissed);
    expect(r.counts.records).toBe(1);
    expect(canRedeclare(r)).toBe(false);
  });
});

describe('confirming a row that wanted a human', () => {
  const COMBINED = [
    ['Katie Fernsby van Aalst', '23/4/2010'].join('\t'),
    ['Tomas Oakhill', '7/11/2010'].join('\t'),
  ].join('\n');

  test('a three-token name asks, and confirming settles it', () => {
    const before = reviewOf(COMBINED, declared(2));
    const katie = before.rows.find((r) => r.key === 1);
    expect(katie.state).toBe('needs-confirmation');
    expect(before.blockers.some((b) => b.kind === 'needs-confirmation')).toBe(true);

    const after = reviewOf(COMBINED, declared(2), resolve({}, 1, { kind: 'confirm' }));
    expect(after.rows.find((r) => r.key === 1).state).toBe('clean');
  });

  test('confirming with edited names keeps the edit', () => {
    const after = reviewOf(
      COMBINED,
      declared(2),
      resolve({}, 1, { kind: 'confirm', firstName: 'Katie', lastName: 'Fernsby van Aalst' }),
    );
    const katie = after.rows.find((r) => r.key === 1);
    expect(katie).toMatchObject({ state: 'clean', firstName: 'Katie', lastName: 'Fernsby van Aalst' });
  });

  test('a confirmed row is still a row — the counts do not move', () => {
    const after = reviewOf(COMBINED, declared(2), resolve({}, 1, { kind: 'confirm' }));
    expect(after.counts.records).toBe(2);
    expect(after.reconciled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// What step 3 says out loud
// ---------------------------------------------------------------------------

describe('the lines step 3 puts on screen', () => {
  test('the ignored columns are named — that line is the tell that mapping went wrong', () => {
    const r = reviewOf(VERTICAL, declared(5));
    expect(ignoredColumnsLine(r)).toBe('3 columns ignored: FormGroup, YearLevel, Email.');
  });

  test('nothing ignored says nothing', () => {
    expect(ignoredColumnsLine(reviewOf(SPREADSHEET, declared(6)))).toBe('');
  });

  test('the ignored count is always on screen, and separates the two kinds', () => {
    const r = reviewOf(VERTICAL, declared(5));
    expect(ignoredSummary(r)).toBe('7 lines ignored before the first student');

    const withDismissal = reviewOf(VERTICAL, declared(5), resolve({}, 8, { kind: 'dismiss' }));
    expect(ignoredSummary(withDismissal)).toBe(
      '13 lines ignored — 7 before the first student, 6 you dismissed',
    );
  });

  test('the reconciliation reads as a sum, because that is what it is (P1)', () => {
    const r = reviewOf(VERTICAL, declared(5));
    expect(reconciliationLine(r)).toBe(
      '5 students + 7 ignored + 0 unreadable = 37 lines pasted.',
    );
  });

  test('the count line says what was expected and what was read, in that order', () => {
    expect(countLine(reviewOf(SPREADSHEET, declared(6)))).toBe(
      'You expected 6 students; we read 6.',
    );
    expect(countLine(reviewOf(SPREADSHEET, declared(21)))).toBe(
      'You expected 21 students; we read 6.',
    );
    expect(countLine(reviewOf(SPREADSHEET, unknown()))).toBe(
      'We read 6 students. Nobody has said how many there should be.',
    );
  });
});

describe('list-level questions with no parse option to answer them', () => {
  const COMMA_NAMES = [
    ['Fernsby, Katie', '23/4/2010'].join('\t'),
    ['Oakhill, Tomas', '7/11/2010'].join('\t'),
  ].join('\n');

  // A comma is deliberately not a delimiter (§7), so `Surname, Given` arrives
  // as one field that is not name-shaped — the mapping refuses it and staff
  // name the column themselves. That makes this the shortest route to the
  // comma question, and it exercises the #71 chips on the way through.
  // `nameOrder` answers P7 alongside it. A comma-split row decides its own
  // order, but the parser asks about the list rather than the row — and
  // leaving that question standing would make `ready` false for a reason this
  // test is not about.
  const AS_COMBINED = { columns: { combined: 0 }, nameOrder: 'first-last' };

  test('a comma-split name blocks until it is acknowledged once for the list', () => {
    // Unlike the name-order and date-orientation questions, this one has no
    // option to pass back to the parser — it is a confirmation, so the
    // resolution log is where it goes, keyed by the list rather than a row.
    const before = reviewOf(COMMA_NAMES, declared(2), {}, AS_COMBINED);
    expect(before.blockers.some((b) => b.kind === 'combined-name-comma')).toBe(true);
    expect(before.ready).toBe(false);

    const after = reviewOf(
      COMMA_NAMES,
      declared(2),
      resolve({}, 'list:combined-name-comma', { kind: 'acknowledge' }),
      AS_COMBINED,
    );
    expect(after.blockers.some((b) => b.kind === 'combined-name-comma')).toBe(false);
    expect(after.ready).toBe(true);
  });

  test('acknowledging one question does not clear another', () => {
    const r = reviewOf(
      COMMA_NAMES,
      declared(2),
      resolve({}, 'list:excel-serial-dates', { kind: 'acknowledge' }),
      AS_COMBINED,
    );
    expect(r.blockers.some((b) => b.kind === 'combined-name-comma')).toBe(true);
  });
});
