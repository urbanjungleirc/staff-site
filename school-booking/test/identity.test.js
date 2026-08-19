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

  test('a preferred-name column changes why it is a variant, never whether', () => {
    const row = student('Katie', 'Fernsby', '2010-04-23');
    const candidates = [contact('Katherine', 'Fernsby', '2010-04-23')];

    const plain = matchStudent(row, candidates);
    const preferred = matchStudent(row, candidates, { firstNameIsPreferred: true });

    expect(preferred.state).toBe('name-variant');
    expect(plain.reason).toBe('first-name-differs');
    // The school's own header called the column a preferred name, so a mismatch
    // here is the expected outcome of a correct match — the operator should be
    // told that rather than shown a bare "different name".
    expect(preferred.reason).toBe('preferred-name-column');
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

  test('a nickname column against twins says the tie-breaker was the weak one', () => {
    const match = matchStudent(
      student('Katie', 'Fernsby', '2010-04-23'),
      [
        contact('Katherine', 'Fernsby', '2010-04-23'),
        contact('Jessica', 'Fernsby', '2010-04-23'),
      ],
      { firstNameIsPreferred: true }
    );
    expect(match.state).toBe('ambiguous');
    expect(match.reason).toBe('preferred-name-column');
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
    // NBSP, zero-width joiner, BOM, curly apostrophe, non-breaking hyphen.
    expect(writeForm('Zoë O’Brien')).toBe("Zoë O'Brien");
    expect(writeForm('Fern​sby﻿')).toBe('Fernsby');
    expect(writeForm('Quarrey‑Blake')).toBe('Quarrey-Blake');
    // Folded only in compare form, never on the way to a permanent record.
    expect(compareForm('MacTAVISH')).toBe('mactavish');
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

    const match = matchStudent(parsed.records[0], [contact('Katherine', 'Fernsby', '2010-04-23')], {
      firstNameIsPreferred: parsed.columns.firstNameIsPreferred,
    });
    expect(match.state).toBe('name-variant');
    expect(match.reason).toBe('preferred-name-column');
  });
});
