// The acceptance bar from #64 and §14: all three committed fixtures parse to
// their exact expected record counts, plus a synthesised phantom-trailing-column
// variant and a CRLF / leading-blank variant.
//
// The fixtures reproduce the *shape* of three real lists with invented data, at
// reduced size — the real lists hold 21, 63 and 18 students (docs/school-lists/
// README.md). Where a count below differs from the number quoted on the ticket,
// it is because the committed fixture is the smaller reproduction; the vertical
// case is additionally tested at its real 21 students, because "21, not 126" is
// the specific failure this module exists to prevent.

import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { ageOn, compareForm, parseStudentList, writeForm } from '../parse.js';

const fixture = (name) =>
  readFileSync(new URL(`../../docs/school-lists/${name}`, import.meta.url), 'utf8');

const VERTICAL = fixture('fixture-1-vertical.txt');
const SPREADSHEET = fixture('fixture-2-spreadsheet.tsv');
const WORD_TABLE = fixture('fixture-3-word-table.txt');

// P1 is the assertion the rest of the rules lean on, so it is checked on every
// parse in this file rather than once: every input line lands in exactly one
// bucket, and a record in a vertical list accounts for all of its lines.
const expectReconciled = (result) => {
  expect(result.counts.reconciled).toBe(true);
  expect(result.counts.accounted).toBe(result.counts.lines);
};

describe('the three committed fixtures', () => {
  test('fixture 1 is a vertical list: 5 students, not 30', () => {
    const result = parseStudentList(VERTICAL);
    expect(result.layout).toBe('vertical');
    expect(result.blockSize).toBe(6);
    expect(result.records).toHaveLength(5);
    expectReconciled(result);
  });

  test('fixture 2 is a 3-column spreadsheet paste: 6 students', () => {
    const result = parseStudentList(SPREADSHEET);
    expect(result.layout).toBe('horizontal');
    expect(result.fieldCount).toBe(3);
    expect(result.records).toHaveLength(6);
    expectReconciled(result);
  });

  test('fixture 3 is a space-aligned Word table: 8 students', () => {
    const result = parseStudentList(WORD_TABLE);
    expect(result.layout).toBe('horizontal');
    expect(result.fieldCount).toBe(3);
    expect(result.records).toHaveLength(8);
    expectReconciled(result);
  });
});

describe('the failure this module exists to prevent', () => {
  // Built at the real list's size rather than the fixture's, because "21, not
  // 126" is the number on the ticket and 5-vs-30 does not read as the same bug.
  const HEADER = ['PreferredName', 'LastName', 'Dob', 'FormGroup', 'YearLevel', 'Email'];
  const student = (n) => [
    `First${n}`,
    `Surname${n}`,
    `${(n % 28) + 1}/${(n % 12) + 1}/2010`,
    'HARLOW',
    '10',
    `first${n}.surname${n}@example.edu.au`,
  ];
  const twentyOne = ['', ...HEADER, ...Array.from({ length: 21 }, (_, i) => student(i + 1)).flat()];

  test('a 21-student vertical list reads as 21 students, not 126', () => {
    const result = parseStudentList(twentyOne.join('\n'));
    expect(result.layout).toBe('vertical');
    expect(result.records).toHaveLength(21);
    expectReconciled(result);
  });
});

describe('variants the committed files cannot carry', () => {
  // Trailing empty fields do not survive being committed and reviewed, so the
  // phantom-column case (styled but empty cells at columns J and W in the real
  // list 2) has to be built here. It is what turns "this list has 3 columns"
  // into "6 columns, three of them blank".
  test('phantom trailing columns do not change the record count', () => {
    // The README's own snippet, unmodified — including what it does to the
    // trailing empty line, which becomes a row of nothing but tabs.
    const withPhantoms = SPREADSHEET.split('\n')
      .map((l) => l + '\t\t\t')
      .join('\n');
    const result = parseStudentList(withPhantoms);
    expect(result.fieldCount).toBe(3);
    expect(result.records).toHaveLength(6);
    expectReconciled(result);
  });

  test('a line of nothing but delimiters is blank, not a one-field junk row', () => {
    const result = parseStudentList(`${SPREADSHEET}\t\t\t`);
    expect(result.records).toHaveLength(6);
    expect(result.ignored.filter((e) => e.reason === 'junk')).toHaveLength(0);
    expectReconciled(result);
  });

  test('CRLF line endings and a leading blank line do not change the counts', () => {
    for (const [name, text, expected] of [
      ['vertical', VERTICAL, 5],
      ['spreadsheet', SPREADSHEET, 6],
      ['word table', WORD_TABLE, 8],
    ]) {
      const crlf = `\r\n${text.replace(/\n/g, '\r\n')}`;
      const result = parseStudentList(crlf);
      expect(result.records, name).toHaveLength(expected);
      expectReconciled(result);
    }
  });

  test('a BOM on the first line is stripped rather than joining the first field', () => {
    const result = parseStudentList(`﻿${SPREADSHEET}`);
    expect(result.records).toHaveLength(6);
    expectReconciled(result);
  });
});

// ---------------------------------------------------------------------------

const tsv = (rows) => rows.map((r) => (Array.isArray(r) ? r.join('\t') : r)).join('\n');

describe('P2 — the list-level inferences are emitted, not just the rows', () => {
  // The dangerous decisions here are list-level, not row-level. What is not
  // emitted cannot be shown, confirmed, or tested.
  test('the vertical fixture reports its layout, mapping and orientation', () => {
    const result = parseStudentList(VERTICAL);
    expect(result.header).toEqual([
      'PreferredName',
      'LastName',
      'Dob',
      'FormGroup',
      'YearLevel',
      'Email',
    ]);
    expect(result.columns).toEqual({
      dob: 2,
      firstName: 0,
      lastName: 1,
      combined: null,
      firstNameIsPreferred: true,
    });
    expect(result.dateOrientation.value).toBe('dmy');
    expect(result.dateOrientation.basis).toBe('proved');
    expect(result.verdict).toBe('read as 6 fields per student — 5 students found');
  });

  test('ignored columns are named, which is the tell that the mapping went wrong', () => {
    const result = parseStudentList(VERTICAL);
    expect(result.ignoredColumns.map((c) => c.label)).toEqual([
      'FormGroup',
      'YearLevel',
      'Email',
    ]);
  });

  test('the header block of a vertical list is ignored, not read as a student', () => {
    const result = parseStudentList(VERTICAL);
    expect(result.ignored.filter((e) => e.reason === 'header')).toHaveLength(6);
    expect(result.ignored.filter((e) => e.reason === 'blank')).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
  });
});

describe('P4 — the DOB anchor, and what happens when it does not hold', () => {
  test('a vertical list is anchored by a constant gap between date-shaped lines', () => {
    const result = parseStudentList(VERTICAL);
    expect(result.blockSize).toBe(6);
    expect(result.columns.dob).toBe(2);
  });

  test('two date positions per block is not a stride, so the paste is refused', () => {
    // Gaps of 1 and 2 alternating: nothing here establishes a block size, and
    // guessing one is how 21 students become 126.
    const result = parseStudentList(
      ['Katie', '23/4/2010', '1/1/2020', 'Tomas', '7/11/2010', '2/2/2020'].join('\n')
    );
    expect(result.refusal.code).toBe('layout-not-held');
    expect(result.records).toHaveLength(0);
    expectReconciled(result);
  });

  test('a single date cannot establish a stride, so it is refused rather than guessed', () => {
    const result = parseStudentList(['Name', 'DOB', 'Katie', '23/4/2010'].join('\n'));
    expect(result.refusal.code).toBe('layout-not-held');
    expectReconciled(result);
  });

  test('no date-shaped column at all is a refusal, not an empty result', () => {
    const result = parseStudentList(
      tsv([
        ['Katie', 'Fernsby', 'HARLOW'],
        ['Tomas', 'Oakhill', 'BRIGGS'],
      ])
    );
    expect(result.refusal.code).toBe('no-dob-column');
    expectReconciled(result);
  });

  test('two date-shaped columns is a refusal, because the DOB is then ambiguous', () => {
    const result = parseStudentList(
      tsv([
        ['Katie', 'Fernsby', '23/4/2010', '1/1/2020'],
        ['Tomas', 'Oakhill', '7/11/2010', '2/2/2020'],
      ])
    );
    expect(result.refusal.code).toBe('dob-column-ambiguous');
    expectReconciled(result);
  });
});

describe('P6 — columns are mapped content-first, never by position', () => {
  test('a five-digit ID column does not steal the anchor from a real date column', () => {
    // The strict-first pass is what makes this hold: a bare five-digit integer
    // is the weakest date shape there is, and a list carrying real dates must
    // never be anchored on one.
    const result = parseStudentList(
      tsv([
        ['First name', 'Surname', 'Student ID', 'DOB'],
        ['Katie', 'Fernsby', '40365', '23/4/2010'],
        ['Tomas', 'Oakhill', '40731', '7/11/2010'],
      ])
    );
    expect(result.columns).toEqual({
      dob: 3,
      firstName: 0,
      lastName: 1,
      combined: null,
      firstNameIsPreferred: false,
    });
    expect(result.ignoredColumns.map((c) => c.label)).toEqual(['Student ID']);
    expect(result.records[0].write.dob).toBe('2010-04-23');
  });

  test('reordering the columns changes the mapping, not the result', () => {
    // Fixed column order is rejected outright: the first school that reorders
    // its export would otherwise produce wrong permanent contacts, silently.
    const result = parseStudentList(
      tsv([
        ['DOB', 'Surname', 'First name'],
        ['23/4/2010', 'Fernsby', 'Katie'],
        ['7/11/2010', 'Oakhill', 'Tomas'],
      ])
    );
    expect(result.columns).toEqual({
      dob: 0,
      firstName: 2,
      lastName: 1,
      combined: null,
      firstNameIsPreferred: false,
    });
    expect(result.records[0].write).toEqual({
      firstName: 'Katie',
      lastName: 'Fernsby',
      dob: '2010-04-23',
    });
  });
});

describe('a preferred name stays tellable apart from a legal first name', () => {
  // CONTEXT.md § "Preferred name": *Avoid: treating it as the first name. The
  // tie-breaker depends on telling them apart.* A first-name mismatch against
  // Clubworx is an expected outcome of a *correct* match when the school ships
  // a nickname column, which weakens the tie-breaker exactly where identity.js
  // needs it — for twins.
  test('a PreferredName column is mapped as the first name but marked as preferred', () => {
    const result = parseStudentList(VERTICAL);
    expect(result.columns.firstName).toBe(0);
    expect(result.columns.firstNameIsPreferred).toBe(true);
  });

  test('an ordinary first-name column is not marked', () => {
    expect(parseStudentList(SPREADSHEET).columns.firstNameIsPreferred).toBe(false);
  });

  test('with no header there is nothing that could say either way, so it is not claimed', () => {
    const result = parseStudentList(
      tsv([
        ['Katie', 'Fernsby', '23/4/2010'],
        ['Tomas', 'Oakhill', '7/11/2010'],
      ])
    );
    expect(result.columns.firstNameIsPreferred).toBe(false);
  });
});

describe('P7 — a headerless list asks which way round the names are', () => {
  const headerless = tsv([
    ['Katie', 'Fernsby', '23/4/2010'],
    ['Tomas', 'Oakhill', '7/11/2010'],
  ]);

  test('the order is asked, defaulted to first-then-last, with real sample rows', () => {
    const result = parseStudentList(headerless);
    const ask = result.needs.find((n) => n.kind === 'name-order');
    expect(ask.default).toBe('first-last');
    expect(ask.samples).toHaveLength(2);
    expect(ask.samples[0].values).toEqual(['Katie', 'Fernsby']);
    expect(result.records[0].write.firstName).toBe('Katie');
  });

  test('answering it swaps the fields and retires the question', () => {
    const result = parseStudentList(headerless, { nameOrder: 'last-first' });
    expect(result.records[0].write).toEqual({
      firstName: 'Fernsby',
      lastName: 'Katie',
      dob: '2010-04-23',
    });
    expect(result.needs.some((n) => n.kind === 'name-order')).toBe(false);
  });

  test('a header names the columns, so nothing is asked', () => {
    expect(parseStudentList(SPREADSHEET).needs.some((n) => n.kind === 'name-order')).toBe(false);
  });
});

describe('P8 — a combined name column, with graded confirmation', () => {
  const combined = tsv([
    ['Name', 'DOB'],
    ['Katie Fernsby', '23/4/2010'],
    ['Mary Jane Oakhill', '7/11/2010'],
    ["O'Brien, Sean", '19/8/2010'],
  ]);

  test('two tokens auto-split, because no other reading exists', () => {
    const result = parseStudentList(combined);
    expect(result.columns.combined).toBe(0);
    expect(result.records[0].write.firstName).toBe('Katie');
    expect(result.records[0].write.lastName).toBe('Fernsby');
    expect(result.records[0].state).toBe('clean');
  });

  test('three or more tokens ask per row, with the split points offered', () => {
    const result = parseStudentList(combined);
    const row = result.records[1];
    expect(row.state).toBe('needs-confirmation');
    expect(row.flags).toContain('name-split');
    const ask = row.needs.find((n) => n.kind === 'name-split');
    expect(ask.tokens).toEqual(['Mary', 'Jane', 'Oakhill']);
    expect(ask.splitPoints).toEqual([1, 2]);
    expect(ask.suggested).toBe(2);
    // A default is applied so the row is showable; the state is what stops it
    // being written before someone agrees.
    expect(row.write).toMatchObject({ firstName: 'Mary Jane', lastName: 'Oakhill' });
  });

  test('a comma auto-splits as Surname, Given and is confirmed once for the list', () => {
    const result = parseStudentList(combined);
    const row = result.records[2];
    expect(row.write.lastName).toBe("O'Brien");
    expect(row.write.firstName).toBe('Sean');
    expect(row.state).toBe('clean');
    expect(result.needs.filter((n) => n.kind === 'combined-name-comma')).toHaveLength(1);
  });

  test('an answered split settles the row, so the UI never re-implements splitting', () => {
    // Every question the module raises has an option that answers it; this is
    // the channel for the per-row one. Row 2 of the paste starts at line 3.
    const result = parseStudentList(combined, { nameSplits: { 3: 1 } });
    const row = result.records[1];
    expect(row.write).toMatchObject({ firstName: 'Mary', lastName: 'Jane Oakhill' });
    expect(row.needs).toEqual([]);
    expect(row.flags).toEqual([]);
    expect(row.state).toBe('clean');
  });

  test('a split point that is not on offer is ignored rather than applied', () => {
    const result = parseStudentList(combined, { nameSplits: { 3: 99 } });
    expect(result.records[1].state).toBe('needs-confirmation');
  });

  test('a single token offers no split, because there is none to confirm', () => {
    const result = parseStudentList(
      tsv([
        ['Name', 'DOB'],
        ['Prince', '23/4/2010'],
      ])
    );
    const row = result.records[0];
    expect(row.flags).toContain('single-token-name');
    expect(row.needs).toEqual([]); // not a question with no answers
    expect(row.state).toBe('needs-confirmation');
  });

  test('no particle list is consulted — van/der/de fall out of the token rule', () => {
    const result = parseStudentList(
      tsv([
        ['Name', 'DOB'],
        ['Priya van der Meer', '23/4/2010'],
      ])
    );
    const ask = result.records[0].needs.find((n) => n.kind === 'name-split');
    expect(ask.tokens).toEqual(['Priya', 'van', 'der', 'Meer']);
    expect(ask.splitPoints).toEqual([1, 2, 3]);
  });
});

describe('P9 — junk is defined by position', () => {
  test('the title line and the prose sentence are junk; the header is a header', () => {
    const result = parseStudentList(WORD_TABLE);
    const reasons = result.ignored.map((e) => e.reason);
    expect(reasons.filter((r) => r === 'junk')).toHaveLength(2);
    expect(reasons.filter((r) => r === 'header')).toHaveLength(1);
    expect(reasons.filter((r) => r === 'blank')).toHaveLength(3);
    expect(result.errors).toHaveLength(0);
  });

  test('a second header row from a merged export is junk, not a student', () => {
    // P9 names three conditions, but the field-count one is what separates junk
    // from the header — which is caught under its own reason. A further
    // modal-width date-free line before the first record has nowhere else to go,
    // and cannot be a hidden student, because position is P9's whole protection.
    const result = parseStudentList(
      tsv([
        ['First name', 'Surname', 'DOB'],
        ['First name', 'Surname', 'DOB'],
        ['Katie', 'Fernsby', '23/4/2010'],
      ])
    );
    expect(result.records).toHaveLength(1);
    expect(result.ignored.map((e) => e.reason)).toEqual(['header', 'junk']);
    expect(result.errors).toHaveLength(0);
    expectReconciled(result);
  });

  test('the same line is junk before the first record and unparseable after it', () => {
    const stray = 'Please add Otto to the list if there is room.';
    const lines = WORD_TABLE.trimEnd().split('\n');

    const before = parseStudentList([...lines.slice(0, 4), stray, ...lines.slice(4)].join('\n'));
    expect(before.ignored.filter((e) => e.reason === 'junk')).toHaveLength(3);
    expect(before.errors).toHaveLength(0);
    expect(before.records).toHaveLength(8);
    expectReconciled(before);

    // After the first good record the same text is where a real student hides,
    // so it blocks Apply (P15) rather than being quietly dropped.
    const after = parseStudentList([...lines, stray].join('\n'));
    expect(after.errors).toHaveLength(1);
    expect(after.errors[0].reason).toBe('unparseable');
    expect(after.ignored.filter((e) => e.reason === 'junk')).toHaveLength(2);
    expect(after.records).toHaveLength(8);
    expectReconciled(after);
  });
});

describe('the layout hypothesis is decided by content, not by the delimiter', () => {
  test('a vertical list survives one stray double-space inside a value', () => {
    // Delimiter-first detection would call this horizontal, find one column,
    // and refuse it for having no name columns — a misleading message for what
    // is really a whole-list layout question.
    const lines = VERTICAL.split('\n');
    const nudged = lines.map((l) => (l === 'Katie' ? 'Katie  Fernsby' : l)).join('\n');
    const result = parseStudentList(nudged);
    expect(result.layout).toBe('vertical');
    expect(result.blockSize).toBe(6);
    expect(result.records).toHaveLength(5);
    expectReconciled(result);
  });
});

describe('P11 — date orientation is a property of the whole list', () => {
  test('one field above 12 fixes the whole list — a proof, not a heuristic', () => {
    const result = parseStudentList(SPREADSHEET);
    expect(result.dateOrientation).toMatchObject({ value: 'dmy', basis: 'proved' });
    // 7/11 is individually ambiguous and is read by the list's orientation.
    expect(result.records[1].write.dob).toBe('2010-11-07');
  });

  test('a proof overrides an answer, because arithmetic outranks a click', () => {
    const result = parseStudentList(SPREADSHEET, { dateOrientation: 'mdy' });
    expect(result.dateOrientation).toMatchObject({ value: 'dmy', basis: 'proved' });
  });

  test('evidence for both orientations refuses the whole paste, naming the two rows', () => {
    const result = parseStudentList(
      tsv([
        ['First name', 'Surname', 'DOB'],
        ['Katie', 'Fernsby', '23/4/2010'],
        ['Tomas', 'Oakhill', '7/25/2010'],
      ])
    );
    expect(result.refusal.code).toBe('date-orientation-contradiction');
    expect(result.refusal.rows.map((r) => r.reading).sort()).toEqual(['dmy', 'mdy']);
    expect(result.refusal.rows.map((r) => r.value)).toEqual(['23/4/2010', '7/25/2010']);
    // Refusing the *paste* has to mean no rows. Reading each self-proving date
    // on its own orientation would be the row-by-row decision P11 forbids, and
    // would hand a caller apply-ready rows for a list that cannot be read.
    expect(result.records).toHaveLength(0);
    expect(result.dateOrientation).toBeNull();
    expectReconciled(result);
  });

  test('a wholly ambiguous list asks, showing a real date read both ways', () => {
    const ambiguous = tsv([
      ['First name', 'Surname', 'DOB'],
      ['Katie', 'Fernsby', '3/4/2010'],
      ['Tomas', 'Oakhill', '5/6/2011'],
    ]);
    const result = parseStudentList(ambiguous);
    expect(result.dateOrientation.basis).toBe('ask');
    expect(result.dateOrientation.sample).toMatchObject({
      value: '3/4/2010',
      dmy: '2010-04-03',
      mdy: '2010-03-04',
    });
    // Never defaulted silently: no row carries a date until the question is
    // answered, and every row says so.
    expect(result.records.map((r) => r.write.dob)).toEqual([null, null]);
    expect(result.records.every((r) => r.state === 'needs-confirmation')).toBe(true);
    expect(result.needs.some((n) => n.kind === 'date-orientation')).toBe(true);

    const answered = parseStudentList(ambiguous, { dateOrientation: 'mdy' });
    expect(answered.dateOrientation.basis).toBe('supplied');
    expect(answered.records.map((r) => r.write.dob)).toEqual(['2010-03-04', '2011-05-06']);
  });

  test('an ISO list is self-identifying and asks nothing', () => {
    const result = parseStudentList(
      tsv([
        ['First name', 'Surname', 'DOB'],
        ['Katie', 'Fernsby', '2010-04-23'],
        ['Tomas', 'Oakhill', '2010-11-07'],
      ])
    );
    expect(result.dateOrientation.basis).toBe('self-identifying');
    expect(result.records.map((r) => r.write.dob)).toEqual(['2010-04-23', '2010-11-07']);
    expect(result.needs.some((n) => n.kind === 'date-orientation')).toBe(false);
  });
});

describe('P12 — the century constraint, and Excel serials', () => {
  test('a two-digit year is 20xx', () => {
    const result = parseStudentList(
      tsv([
        ['First name', 'Surname', 'DOB'],
        ['Katie', 'Fernsby', '23/4/10'],
        ['Tomas', 'Oakhill', '7/11/11'],
      ])
    );
    expect(result.records.map((r) => r.write.dob)).toEqual(['2010-04-23', '2011-11-07']);
  });

  test('a DOB before 2000 is flagged not-a-student — sharper than guessing at names', () => {
    const result = parseStudentList(
      tsv([
        ['First name', 'Surname', 'DOB'],
        ['Katie', 'Fernsby', '23/4/2010'],
        ['Alison', 'Thornbury', '14/6/1978'],
      ])
    );
    expect(result.records).toHaveLength(2); // flagged, never dropped
    expect(result.records[0].flags).toEqual([]);
    expect(result.records[1].flags).toContain('not-a-student');
    expect(result.records[1].state).toBe('needs-confirmation');
  });

  test('serials convert on the 1900 epoch, and the resulting dates are surfaced', () => {
    const result = parseStudentList(
      tsv([
        ['First name', 'Surname', 'Birth date'],
        ['Katie', 'Fernsby', '40365'],
        ['Tomas', 'Oakhill', '40731'],
      ])
    );
    // The range the real list 2 actually holds: 2010-07-06 to 2011-07-07.
    expect(result.records.map((r) => r.write.dob)).toEqual(['2010-07-06', '2011-07-07']);
    // Not unambiguous — 1900 and 1904 are 1462 days apart — so the confirmation
    // is on the resulting dates, which staff can check against expected ages.
    expect(result.records.every((r) => r.flags.includes('excel-serial'))).toBe(true);
    expect(result.records.every((r) => r.state === 'needs-confirmation')).toBe(true);
    expect(result.needs.some((n) => n.kind === 'excel-serial-dates')).toBe(true);
  });

  test('an impossible date is an error, not a silently shifted one', () => {
    const result = parseStudentList(
      tsv([
        ['First name', 'Surname', 'DOB'],
        ['Katie', 'Fernsby', '23/4/2010'],
        ['Tomas', 'Oakhill', '31/2/2010'],
      ])
    );
    expect(result.records).toHaveLength(1);
    expect(result.errors[0].reason).toBe('invalid-date');
    expectReconciled(result);
  });
});

describe('P13 — an implausible age is needs-confirmation, not a block', () => {
  const list = tsv([
    ['First name', 'Surname', 'DOB'],
    ['Katie', 'Fernsby', '23/4/2010'],
    ['Tiny', 'Tot', '23/4/2024'],
  ]);

  test('age is measured against the event date, and the run is not refused', () => {
    const result = parseStudentList(list, { eventDate: '2026-09-02' });
    expect(result.records).toHaveLength(2);
    expect(result.records[0].flags).toEqual([]);
    expect(result.records[1].flags).toContain('implausible-age');
    expect(result.records[1].state).toBe('needs-confirmation');
    expect(result.refusal).toBeNull();
  });

  test('without an event date there is nothing to measure against, so nothing is flagged', () => {
    const result = parseStudentList(list);
    expect(result.records[1].flags).toEqual([]);
  });

  test('ageOn does not credit a birthday that has not happened yet', () => {
    expect(ageOn('2010-09-10', '2026-09-02')).toBe(15);
    expect(ageOn('2010-09-02', '2026-09-02')).toBe(16);
  });
});

describe('P14 — duplicates collapse visibly, twins stay as two rows', () => {
  const list = tsv([
    ['First name', 'Surname', 'DOB'],
    ['Katie', 'Fernsby', '23/4/2010'],
    ['KATIE', 'Fernsby', '23/4/2010'],
    ['Nils', 'Quarrey', '19/8/2010'],
    ['Bea', 'Quarrey', '19/8/2010'],
  ]);

  test('the same student listed twice collapses to one badged row', () => {
    const result = parseStudentList(list);
    const katie = result.records.find((r) => r.compare.firstName === 'katie');
    expect(katie.flags).toContain('listed-twice');
    expect(katie.duplicateCount).toBe(2);
    // Both source lines stay attached to the survivor, which is what keeps the
    // reconciliation honest through a collapse.
    expect(katie.lineNumbers).toEqual([2, 3]);
    // Case is never touched on the write form, so the first spelling survives.
    expect(katie.write.firstName).toBe('Katie');
  });

  test('same surname and birthday, different first name, stays as two rows', () => {
    const result = parseStudentList(list);
    const quarreys = result.records.filter((r) => r.compare.lastName === 'quarrey');
    expect(quarreys).toHaveLength(2);
    expect(quarreys.every((r) => r.flags.includes('possible-siblings'))).toBe(true);
    // Collapsing on surname + DOB alone would merge twins into one student, and
    // nobody discovers the missing child until the session.
    expect(quarreys.map((r) => r.write.firstName).sort()).toEqual(['Bea', 'Nils']);
  });

  test('a collapse never breaks the line reconciliation', () => {
    const result = parseStudentList(list);
    expect(result.records).toHaveLength(3);
    expectReconciled(result);
  });
});

describe('P10 — write form and compare form, kept apart', () => {
  test('write form repairs the characters a Word export brings, and nothing else', () => {
    expect(writeForm('  Zoë   O’Brien  ')).toBe("Zoë O'Brien");
    expect(writeForm('Quarrey‑Blake')).toBe('Quarrey-Blake');
    expect(writeForm('Van Dermeer')).toBe('Van Dermeer');
    expect(writeForm('Fern​sby﻿')).toBe('Fernsby');
    // Case is never touched and accents are never stripped: this string is
    // written into a record that cannot be deleted.
    expect(writeForm('MacTAVISH')).toBe('MacTAVISH');
    expect(writeForm('Ferná́ndez'.normalize('NFD'))).toBe('Ferná́ndez'.normalize('NFC'));
  });

  test("compare form is what lets O'Brien match OBrien without ever writing OBrien", () => {
    expect(compareForm("O'Brien")).toBe('obrien');
    expect(compareForm('OBrien')).toBe('obrien');
    expect(compareForm("o’brien")).toBe('obrien');
    expect(compareForm('Quarrey-Blake')).toBe('quarreyblake');
    expect(compareForm('Van Dermeer')).toBe('vandermeer');
  });

  // #80. The accent is the same class of variance as the apostrophe: one list
  // types it, one contact record does not, and in a *surname* the mismatch is
  // silent — the candidate never narrows, an existing student reports `new`, and
  // a second permanent contact is written with nobody asked.
  test('compare form folds accents, so Fernandez matches Fernández', () => {
    expect(compareForm('Fernández')).toBe('fernandez');
    expect(compareForm('Fernandez')).toBe('fernandez');
    expect(compareForm('Zoë')).toBe('zoe');
    expect(compareForm('Nguyễn')).toBe('nguyen');
    // Decomposed and precomposed spellings of one name agree, which is what
    // makes this safe to apply to input pasted from anywhere.
    expect(compareForm('Fernández'.normalize('NFD'))).toBe('fernandez');
  });

  test('write form still never strips an accent — the split is the point', () => {
    expect(writeForm('Fernández')).toBe('Fernández');
    expect(writeForm('Zoë')).toBe('Zoë');
    expect(writeForm('Nguyễn')).toBe('Nguyễn');
  });

  test('folding reaches only marks on a Latin base letter', () => {
    // `\p{M}` would have been the obvious rule and is the wrong one: in an abugida
    // the vowel signs are marks, so stripping them deletes letters —
    // `प्रिया` becomes `परय` — and can collapse two different children onto one
    // compare form. A false match is worse than a missed one: it attaches a pass
    // and bookings to the wrong child, where a miss only creates a duplicate.
    expect(compareForm('สมชาย')).toBe('สมชาย');
    expect(compareForm('प्रिया')).toBe('प्रिया');
    expect(compareForm('김민준')).toBe('김민준');
  });

  test('Cyrillic is left alone, because there the marks make different letters', () => {
    // The combining-diacritics block is script-neutral, so an ungated rule folds
    // `й` onto `и` and `ё` onto `е`. Those are separate letters of the Russian
    // alphabet, not accented spellings of one — Андрей and Андреи are two names.
    // This is why the regex requires a Latin base letter rather than trusting the
    // block to mean "accent".
    expect(compareForm('Андрей')).not.toBe(compareForm('Андреи'));
    expect(compareForm('Алёна')).not.toBe(compareForm('Алена'));
  });

  test('Vietnamese tone marks DO fold — an accepted trade, not an oversight', () => {
    // Vietnamese is Latin script, so the rule reaches it and `Lê`, `Lệ` and `Lễ`
    // share one compare form even though they are different names. Pinned here so
    // the cost is visible rather than discovered.
    //
    // Accepted because this is the case #80 was filed about — a school types
    // `Nguyen`, the contact record says `Nguyễn`, and the student silently gets a
    // second permanent contact. The false match it risks additionally needs the
    // surname, the birthday *and* the first name to coincide; the miss it
    // prevents needs none of that and happens on ordinary lists.
    expect(compareForm('Nguyễn')).toBe('nguyen');
    expect(compareForm('Lê')).toBe(compareForm('Lệ'));
    expect(compareForm('Đặng')).toBe(compareForm('Đăng'));
  });

  test('#80 reaches in-paste dedup too: one child spelled two ways collapses', () => {
    // compare form drives P14 as well as matching, so this is a second consequence
    // of the same change — and the right one. A school merging two class exports
    // is exactly how a list gains a duplicate, and the two exports need not agree
    // about the accent. Before #80 these were two students, and the second would
    // have earned its own permanent contact.
    const result = parseStudentList(
      tsv([
        ['First name', 'Surname', 'DOB'],
        ['Ana', 'Fernández', '23/4/2010'],
        ['Ana', 'Fernandez', '23/4/2010'],
      ])
    );
    expect(result.records).toHaveLength(1);
    expect(result.records[0].flags).toContain('listed-twice');
    // The surviving row keeps the spelling the school actually typed first.
    expect(result.records[0].write.lastName).toBe('Fernández');
    expectReconciled(result);
  });

  test('a letter that carries its stroke inside itself is not folded', () => {
    // ł, ø and ß do not decompose, so no mark-stripping rule reaches them. This
    // is a known limit of #80 rather than an oversight: `Wałęsa` matches
    // `Wałesa` but not `Walesa`.
    expect(compareForm('Wałęsa')).toBe('wałesa');
    expect(compareForm('Sørensen')).toBe('sørensen');
    expect(compareForm('Straße')).toBe('straße');
  });

  test('every record carries both forms', () => {
    const result = parseStudentList(
      tsv([
        ['First name', 'Surname', 'DOB'],
        ['Bea', "O’Lindhardt", '23/4/2010'],
      ])
    );
    expect(result.records[0].write.lastName).toBe("O'Lindhardt");
    expect(result.records[0].compare.lastName).toBe('olindhardt');
    expect(result.records[0].raw.lastName).toBe('O’Lindhardt');
  });
});

describe('P1 — the reconciliation holds through the messy cases', () => {
  test('junk, a header, blanks, a duplicate and an unparseable row all add up', () => {
    const messy = [
      'Example Grammar College Somewhere',
      '',
      'List of students attending weekly Rock Climbing.',
      '',
      ['First name', 'Surname', 'DOB'].join('\t'),
      '',
      ['Katie', 'Fernsby', '23/4/2010'].join('\t'),
      ['Katie', 'Fernsby', '23/4/2010'].join('\t'),
      ['Nils', 'Quarrey', '19/8/2010'].join('\t'),
      'and Otto if there is room',
      ['Bea', 'Lindhardt', '1/2/2011'].join('\t'),
    ].join('\n');

    const result = parseStudentList(messy);
    expect(result.records).toHaveLength(3);
    expect(result.errors).toHaveLength(1);
    expect(result.counts.lines).toBe(11);
    expect(result.counts.recordLines).toBe(4); // three records, one holding two lines
    expectReconciled(result);
  });

  test('an empty paste reconciles too', () => {
    const result = parseStudentList('');
    expect(result.records).toHaveLength(0);
    expectReconciled(result);
  });
});
