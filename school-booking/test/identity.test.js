// The matching rule (#65): surname + DOB narrows, first name breaks ties, and
// first-name variance is surfaced rather than merged.
//
// Rules are §5 of docs/superpowers/specs/2026-08-19-school-group-booking-design.md.
// Every candidate set below is invented — no real student name, DOB or school
// name belongs in this repo (§16).

import { describe, expect, test } from 'vitest';
import { compareForm, parseStudentList, writeForm } from '../parse.js';
import { matchStudent } from '../identity.js';

// A student row in the shape `parseStudentList` emits, so these tests speak the
// same vocabulary as the parser's output rather than a convenient invention.
const student = (firstName, lastName, dob) => ({
  write: { firstName, lastName, dob },
  compare: { firstName: compareForm(firstName), lastName: compareForm(lastName) },
});

// A Clubworx contact in the shape the three status endpoints return — the field
// names are the schema measured in probes/49-plus-addressed-duplicates.md.
const contact = (first_name, last_name, dob, contact_key = `k-${last_name}-${first_name}`) => ({
  contact_key,
  first_name,
  last_name,
  dob,
  status: 'Prospect',
});

describe('a student nobody has a contact for is new', () => {
  test('an empty candidate set is `new`', () => {
    const match = matchStudent(student('Katie', 'Fernsby', '2010-04-23'), []);
    expect(match.state).toBe('new');
    expect(match.contact).toBe(null);
  });

  test('candidates that share neither surname nor birthday are still `new`', () => {
    const match = matchStudent(student('Katie', 'Fernsby', '2010-04-23'), [
      contact('Katie', 'Quarrey', '2010-04-23'),
      contact('Katie', 'Fernsby', '2011-04-23'),
    ]);
    expect(match.state).toBe('new');
    expect(match.candidates).toHaveLength(0);
  });
});

describe('surname + DOB narrows, first name confirms', () => {
  test('one candidate with the same first name is `matched`, and carries the contact', () => {
    const match = matchStudent(student('Katie', 'Fernsby', '2010-04-23'), [
      contact('Katie', 'Fernsby', '2010-04-23', 'k-1'),
    ]);
    expect(match.state).toBe('matched');
    expect(match.contact.contact_key).toBe('k-1');
  });

  test("matching runs on compare form: O'Brien matches OBrien, without writing OBrien", () => {
    const match = matchStudent(student("Bea", "O'Brien", '2010-04-23'), [
      contact('bea', 'OBrien', '2010-04-23', 'k-2'),
    ]);
    expect(match.state).toBe('matched');
    expect(match.contact.contact_key).toBe('k-2');
    // The write form the run would send is untouched by the match.
    expect(writeForm("O'Brien")).toBe("O'Brien");
  });
});

describe('first-name variance is surfaced, never auto-merged', () => {
  test('one candidate with a different first name is a `name-variant`, not a match', () => {
    const match = matchStudent(student('Katie', 'Fernsby', '2010-04-23'), [
      contact('Katherine', 'Fernsby', '2010-04-23', 'k-3'),
    ]);
    expect(match.state).toBe('name-variant');
    // Deliberately withheld: a caller reusing `match.contact` cannot accept a
    // variance no human has looked at.
    expect(match.contact).toBe(null);
    expect(match.candidates.map((c) => c.contact_key)).toEqual(['k-3']);
  });

  test('a preferred-name column says the mismatch was expected, never that it is fine', () => {
    const row = student('Katie', 'Fernsby', '2010-04-23');
    const candidates = [contact('Katherine', 'Fernsby', '2010-04-23')];

    const plain = matchStudent(row, candidates);
    const preferred = matchStudent(row, candidates, { firstNameIsPreferred: true });

    // Same state and same reason: what happened is identical, and it is still not
    // accepted for anyone.
    expect(preferred.state).toBe('name-variant');
    expect(preferred.reason).toBe('first-name-differs');
    expect(preferred.contact).toBe(null);
    // The school's own header called the column a preferred name, so a mismatch
    // here is the expected outcome of a correct match. That is a second fact, not
    // a different reason — the operator needs both to word the decision.
    expect(plain.firstNameIsPreferred).toBe(false);
    expect(preferred.firstNameIsPreferred).toBe(true);
  });
});

describe('twins: the case the first-name tie-breaker exists for', () => {
  test('two contacts sharing surname and birthday resolve to one each, never merged', () => {
    const inClubworx = [
      contact('Katherine', 'Fernsby', '2010-04-23', 'k-twin-a'),
      contact('Jessica', 'Fernsby', '2010-04-23', 'k-twin-b'),
    ];

    const one = matchStudent(student('Katherine', 'Fernsby', '2010-04-23'), inClubworx);
    const two = matchStudent(student('Jessica', 'Fernsby', '2010-04-23'), inClubworx);

    expect(one.state).toBe('matched');
    expect(two.state).toBe('matched');
    expect(one.contact.contact_key).toBe('k-twin-a');
    expect(two.contact.contact_key).toBe('k-twin-b');
  });

  test('twins whose paste names match neither contact are `ambiguous`, with both offered', () => {
    const match = matchStudent(student('Katie', 'Fernsby', '2010-04-23'), [
      contact('Katherine', 'Fernsby', '2010-04-23', 'k-twin-a'),
      contact('Jessica', 'Fernsby', '2010-04-23', 'k-twin-b'),
    ]);
    expect(match.state).toBe('ambiguous');
    expect(match.reason).toBe('no-first-name-match');
    expect(match.contact).toBe(null);
    expect(match.candidates).toHaveLength(2);
  });

  test('a nickname column against twins keeps both facts: no name match, and expected', () => {
    // This is where the tie-breaker is weakest — two children, and the only field
    // that separates them is the one the school replaced with a nickname.
    const match = matchStudent(
      student('Katie', 'Fernsby', '2010-04-23'),
      [
        contact('Katherine', 'Fernsby', '2010-04-23'),
        contact('Jessica', 'Fernsby', '2010-04-23'),
      ],
      { firstNameIsPreferred: true }
    );
    expect(match.state).toBe('ambiguous');
    expect(match.reason).toBe('no-first-name-match');
    expect(match.firstNameIsPreferred).toBe(true);
  });
});

describe('duplicate contacts already in Clubworx', () => {
  test('two contacts with the same name and birthday are `ambiguous`, never picked for us', () => {
    // Contacts cannot be deleted through the API (ACCESS.md §4), so a database
    // of ~60,000 people holds duplicates. Silently taking the first would attach
    // a pass and bookings to whichever row the search happened to return first.
    const match = matchStudent(student('Katie', 'Fernsby', '2010-04-23'), [
      contact('Katie', 'Fernsby', '2010-04-23', 'k-dup-a'),
      contact('katie', 'Fernsby', '2010-04-23', 'k-dup-b'),
    ]);
    expect(match.state).toBe('ambiguous');
    expect(match.reason).toBe('duplicate-contacts');
    expect(match.contact).toBe(null);
    expect(match.candidates.map((c) => c.contact_key)).toEqual(['k-dup-a', 'k-dup-b']);
  });
});

describe('the DOB gaps, both of which would otherwise end in a duplicate contact', () => {
  test('a row whose DOB never parsed is `unmatchable`, never `new`', () => {
    // Half the identity key is missing, so nothing can be concluded. Calling it
    // `new` would create a permanent contact with no DOB, which then poisons the
    // surname + DOB key for every later term.
    const match = matchStudent(student('Katie', 'Fernsby', null), [
      contact('Katie', 'Fernsby', '2010-04-23'),
    ]);
    expect(match.state).toBe('unmatchable');
    expect(match.reason).toBe('no-dob');
    expect(match.contact).toBe(null);
  });

  test('a row with no surname is `unmatchable` too — DOB alone is not an identity', () => {
    // `parse.js` emits an empty surname for an unsplittable single-token name and
    // holds the row at needs-confirmation. If one ever reaches here, matching on
    // the birthday alone would pick whichever contact shares it.
    const match = matchStudent(student('Otto', '', '2010-04-23'), [
      contact('Otto', '', '2010-04-23'),
    ]);
    expect(match.state).toBe('unmatchable');
    expect(match.reason).toBe('no-surname');
  });

  test('a same-name candidate with no DOB recorded is `ambiguous`, never `new`', () => {
    // Contacts created by hand often carry no DOB, and a list response is not
    // guaranteed to fill it (probes/lib/identity.mjs). Discarding the row would
    // report a student who already exists as `new` and create a second contact
    // for them.
    const match = matchStudent(student('Katie', 'Fernsby', '2010-04-23'), [
      contact('Katie', 'Fernsby', null, 'k-nodob'),
    ]);
    expect(match.state).toBe('ambiguous');
    expect(match.reason).toBe('candidate-dob-unknown');
    expect(match.candidates.map((c) => c.contact_key)).toEqual(['k-nodob']);
  });

  test('a confirmed candidate beside a DOB-less twin of itself still matches', () => {
    // The asymmetry is deliberate: the blank-DOB rule exists to stop this tool
    // creating a second contact, and here it creates nothing. Reusing the
    // better-identified record is the safe outcome, so this stays a match rather
    // than becoming a question the operator cannot usefully answer.
    const match = matchStudent(student('Katie', 'Fernsby', '2010-04-23'), [
      contact('Katie', 'Fernsby', '2010-04-23', 'k-with-dob'),
      contact('Katie', 'Fernsby', null, 'k-without-dob'),
    ]);
    expect(match.state).toBe('matched');
    expect(match.contact.contact_key).toBe('k-with-dob');
  });

  test('a DOB-less candidate with a different first name is not a candidate at all', () => {
    // Surname alone is not an identity: a school list holds siblings, and this
    // would otherwise make every sibling ambiguous forever.
    const match = matchStudent(student('Katie', 'Fernsby', '2010-04-23'), [
      contact('Jessica', 'Fernsby', null),
    ]);
    expect(match.state).toBe('new');
  });
});

describe('the candidate set is re-checked, not trusted', () => {
  test('a matching first name and DOB under another surname is discarded', () => {
    const match = matchStudent(student('Katie', 'Fernsby', '2010-04-23'), [
      contact('Katie', 'Quarrey', '2010-04-23'),
    ]);
    expect(match.state).toBe('new');
  });
});

// P10's two forms are asserted in parse.test.js as well. Re-asserting them here
// against the *imported* functions is the point: a test that fails the moment
// this module stops sharing one normalisation table is exactly the alarm the
// boundary needs, because the drift itself throws nothing.
describe('P10 — the imported normalisation, and what it buys the match', () => {
  test("O'Brien, OBrien and o'brien are one compare form and three write forms", () => {
    expect(compareForm("O'Brien")).toBe('obrien');
    expect(compareForm('OBrien')).toBe('obrien');
    expect(compareForm("o’brien")).toBe('obrien');

    expect(writeForm("O'Brien")).toBe("O'Brien");
    expect(writeForm('OBrien')).toBe('OBrien');
    expect(writeForm("o’brien")).toBe("o'brien");
  });

  test('write form keeps case and accents, and repairs what a Word export brings', () => {
    expect(writeForm('MacTAVISH')).toBe('MacTAVISH');
    expect(writeForm('Zoë')).toBe('Zoë');
    // The invisible ones are written as escapes on purpose. A literal U+00A0 in
    // this file is indistinguishable from a plain space on screen, and an editor
    // that helpfully normalises it leaves a test that asserts nothing while its
    // comment still claims NBSP coverage.
    expect(writeForm('Zoë Van Dermeer')).toBe('Zoë Van Dermeer');
    expect(writeForm('Fern​sby﻿')).toBe('Fernsby');
    expect(writeForm('﻿Katie')).toBe('Katie');
    // These two are legible as themselves: U+2019 curly apostrophe, U+2011
    // non-breaking hyphen — both expected input from the Word-exported list.
    expect(writeForm('Zoë O’Brien')).toBe("Zoë O'Brien");
    expect(writeForm('Quarrey‑Blake')).toBe('Quarrey-Blake');
    // Case is folded only in compare form, never on the way to a permanent record.
    expect(compareForm('MacTAVISH')).toBe('mactavish');
  });

  test('an accent no longer decides whether a student is found (#80)', () => {
    // This test previously pinned the opposite, as the record of a known gap.
    // #80 closed it in compare form only: an accented surname used to stop the
    // candidate narrowing at all, so an existing student reported `new` and
    // earned a second permanent contact with nobody asked.
    const surnameAccent = matchStudent(student('Ana', 'Fernandez', '2010-04-23'), [
      contact('Ana', 'Fernández', '2010-04-23', 'k-accent'),
    ]);
    expect(surnameAccent.state).toBe('matched');
    expect(surnameAccent.contact.contact_key).toBe('k-accent');

    // Both directions, because either side can be the one carrying the accent.
    const pasteHasAccent = matchStudent(student('Zoë', 'Van Dermeer', '2010-04-23'), [
      contact('Zoe', 'Van Dermeer', '2010-04-23'),
    ]);
    expect(pasteHasAccent.state).toBe('matched');

    // And the write form is still the school's spelling, untouched — which is the
    // whole reason the two forms are kept apart.
    expect(writeForm('Fernández')).toBe('Fernández');
  });

  test('a contact stored with a curly apostrophe still matches a straight-typed paste', () => {
    // The write path can never produce this, but ~60,000 existing contacts were
    // not all created by this tool.
    const match = matchStudent(student('Bea', "O'Brien", '2010-04-23'), [
      contact('Bea', 'O’Brien', '2010-04-23', 'k-curly'),
    ]);
    expect(match.state).toBe('matched');
    expect(match.contact.contact_key).toBe('k-curly');
  });

  test('a hyphenated surname matches whichever hyphen the record holds', () => {
    const match = matchStudent(student('Nils', 'Quarrey-Blake', '2010-08-19'), [
      contact('Nils', 'Quarrey‑Blake', '2010-08-19', 'k-hyphen'),
    ]);
    expect(match.state).toBe('matched');
  });
});

// P14 — whether a pair of rows is a true duplicate or twins is already decided in
// parse.js, on compare-form first name. This module consumes those rows; it does
// not re-decide them.
describe('the handoff from the parser', () => {
  const tsv = (rows) => rows.map((row) => row.join('\t')).join('\n');

  test('a collapsed duplicate arrives as one row and matches one contact', () => {
    const parsed = parseStudentList(
      tsv([
        ['First name', 'Surname', 'DOB'],
        ['Katie', 'Fernsby', '23/4/2010'],
        ['Katie', 'Fernsby', '23/4/2010'],
      ])
    );
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0].flags).toContain('listed-twice');

    const match = matchStudent(parsed.records[0], [
      contact('Katie', 'Fernsby', '2010-04-23', 'k-once'),
    ]);
    expect(match.state).toBe('matched');
    expect(match.contact.contact_key).toBe('k-once');
  });

  test('twins arrive as two rows and take one contact each', () => {
    const parsed = parseStudentList(
      tsv([
        ['First name', 'Surname', 'DOB'],
        ['Katherine', 'Fernsby', '23/4/2010'],
        ['Jessica', 'Fernsby', '23/4/2010'],
      ])
    );
    expect(parsed.records).toHaveLength(2);
    expect(parsed.records[0].flags).toContain('possible-siblings');

    const inClubworx = [
      contact('Katherine', 'Fernsby', '2010-04-23', 'k-a'),
      contact('Jessica', 'Fernsby', '2010-04-23', 'k-b'),
    ];
    const keys = parsed.records.map((row) => matchStudent(row, inClubworx).contact?.contact_key);
    expect(keys).toEqual(['k-a', 'k-b']);
  });

  test("the list's preferred-name column reaches the match through columns", () => {
    const parsed = parseStudentList(
      tsv([
        ['Preferred name', 'Surname', 'DOB'],
        ['Katie', 'Fernsby', '23/4/2010'],
      ])
    );
    expect(parsed.columns.firstNameIsPreferred).toBe(true);

    // The parser's whole `columns` object goes through, so there is no boolean to
    // forget copying.
    const match = matchStudent(
      parsed.records[0],
      [contact('Katherine', 'Fernsby', '2010-04-23')],
      parsed.columns
    );
    expect(match.state).toBe('name-variant');
    expect(match.firstNameIsPreferred).toBe(true);
  });

  test('a parser refusal path hands over a null columns object without throwing', () => {
    const match = matchStudent(student('Katie', 'Fernsby', '2010-04-23'), [], null);
    expect(match.state).toBe('new');
    expect(match.firstNameIsPreferred).toBe(false);
  });
});
