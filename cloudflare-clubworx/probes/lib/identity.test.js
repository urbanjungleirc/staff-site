import { describe, it, expect } from 'vitest';
import {
  TEST_IDENTITY,
  PROBE_CONTACTS,
  assertProbeIdentity,
  planContacts,
  pickProbeRows,
  plusTag,
} from './identity.mjs';

// Clubworx cannot delete a contact through the API, so every contact a probe
// creates is permanent and removable only by hand. That single fact is what
// each assertion here is protecting: the set must be the smallest one that
// answers staff-site#49, and nothing outside it may ever be written.

describe('PROBE_CONTACTS', () => {
  it('is the three contacts authorised for #49, and no more', () => {
    // ACCESS.md section 4 authorised one identity; #49 needs three, agreed
    // 2026-08-17. Any growth beyond that is a decision, not a refactor.
    expect(PROBE_CONTACTS).toHaveLength(3);
  });

  it('marks every contact as unmistakably not a student', () => {
    for (const contact of PROBE_CONTACTS) {
      expect(contact.first_name).toBe('Ztest');
      expect(contact.last_name.startsWith('Wayfinder')).toBe(true);
      expect(contact.dob).toBe('1900-01-01');
    }
  });

  it('has two contacts sharing one email — the case #49 question 2 asks about', () => {
    // Siblings share a parent's address, so "many contacts, one email" is the
    // real scenario. It cannot be answered with a single contact.
    const byEmail = {};
    for (const c of PROBE_CONTACTS) byEmail[c.email] = (byEmail[c.email] ?? 0) + 1;
    expect(Object.values(byEmail).sort()).toEqual([1, 2]);
  });

  it('has a second plus-tag, so the isolation query has something to exclude', () => {
    // #49 question 3 asks whether email=noreply+stmarys isolates one school. A
    // single tag can only show a match, never an exclusion.
    const tags = new Set(PROBE_CONTACTS.map(c => plusTag(c.email)));
    expect(tags.size).toBe(2);
  });

  it('starts from the identity ACCESS.md agreed', () => {
    expect(PROBE_CONTACTS[0]).toMatchObject({
      first_name: TEST_IDENTITY.first_name,
      last_name: TEST_IDENTITY.last_name,
      email: TEST_IDENTITY.email,
      dob: TEST_IDENTITY.dob,
    });
  });
});

describe('assertProbeIdentity', () => {
  it('accepts every contact the probe is authorised to create', () => {
    for (const contact of PROBE_CONTACTS) {
      expect(() => assertProbeIdentity(contact)).not.toThrow();
    }
  });

  it('refuses a real-looking name', () => {
    // The blast-radius control. A contact written under a real name is
    // permanent, in a 60,000-person production database, and indistinguishable
    // from a genuine record afterwards.
    expect(() => assertProbeIdentity({ ...PROBE_CONTACTS[0], first_name: 'Katie' })).toThrow(
      /Ztest/,
    );
  });

  it('refuses a surname outside the Wayfinder family', () => {
    expect(() => assertProbeIdentity({ ...PROBE_CONTACTS[0], last_name: 'Fernsby' })).toThrow(
      /Wayfinder/,
    );
  });

  it('refuses an email that is not a noreply+ probe address', () => {
    expect(() =>
      assertProbeIdentity({ ...PROBE_CONTACTS[0], email: 'parent@example.com' }),
    ).toThrow(/noreply\+/);
  });

  it('refuses a plausible date of birth', () => {
    // 1900-01-01 is the marker. A real DOB would make the record look like a
    // student even to someone reading it in the Clubworx UI.
    expect(() => assertProbeIdentity({ ...PROBE_CONTACTS[0], dob: '2010-07-06' })).toThrow(/dob/i);
  });

  it('refuses a contact missing a field entirely', () => {
    expect(() => assertProbeIdentity({ first_name: 'Ztest' })).toThrow();
  });
});

describe('planContacts', () => {
  const wanted = PROBE_CONTACTS;

  it('creates all three when the gym holds none of them', () => {
    const plan = planContacts({ wanted, existing: [] });
    expect(plan.create).toHaveLength(3);
    expect(plan.reuse).toHaveLength(0);
  });

  it('reuses an existing probe contact rather than creating a second', () => {
    // ACCESS.md: "the identity is only a blast-radius control if there is
    // exactly one of it". A re-run must cost nothing permanent.
    const existing = [{ contact_key: 'key-a', email: wanted[0].email, last_name: wanted[0].last_name }];
    const plan = planContacts({ wanted, existing });

    expect(plan.reuse).toHaveLength(1);
    expect(plan.reuse[0].contact_key).toBe('key-a');
    expect(plan.create.map(c => c.label)).toEqual(['B', 'C']);
  });

  it('creates nothing on a second full run', () => {
    const existing = wanted.map((c, i) => ({
      contact_key: `key-${i}`,
      email: c.email,
      last_name: c.last_name,
    }));
    expect(planContacts({ wanted, existing }).create).toHaveLength(0);
  });

  it('tells A and B apart by surname, though they share an email', () => {
    // Matching on email alone would see B as already present the moment A
    // exists, and question 2 would never be asked.
    const existing = [{ contact_key: 'key-a', email: wanted[0].email, last_name: wanted[0].last_name }];
    const plan = planContacts({ wanted, existing });
    expect(plan.create.some(c => c.email === wanted[0].email)).toBe(true);
  });

  it('ignores a stranger who happens to share the probe email', () => {
    // A partial-match search returns anything, including rows this probe did
    // not write. Treating one as "already created" would skip a write and
    // silently answer question 2 with someone else's record.
    const existing = [{ contact_key: 'key-x', email: wanted[0].email, last_name: 'Nguyen' }];
    expect(planContacts({ wanted, existing }).create).toHaveLength(3);
  });
});

describe('pickProbeRows', () => {
  // The search that feeds planContacts is a partial email match, so it returns
  // strangers. This is where they are dropped — before their email and surname
  // reach a plan, a log line, or probes/out/. summariseContacts protects the
  // reporting path; this protects the planning path.
  const probeRow = {
    contact_key: 'ck-a',
    first_name: 'Ztest',
    last_name: 'Wayfinder',
    email: TEST_IDENTITY.email,
  };
  const strangerRow = {
    contact_key: 'ck-real',
    first_name: 'Katie',
    last_name: 'Fernsby',
    email: 'parent@example.com',
  };

  it('keeps rows this probe could have written', () => {
    expect(pickProbeRows([probeRow, strangerRow])).toHaveLength(1);
    expect(pickProbeRows([probeRow, strangerRow])[0].contact_key).toBe('ck-a');
  });

  it('carries nothing about a stranger into the result', () => {
    const json = JSON.stringify(pickProbeRows([probeRow, strangerRow]));
    expect(json).not.toContain('Fernsby');
    expect(json).not.toContain('parent@example.com');
    expect(json).not.toContain('ck-real');
  });

  it('keeps only the three fields planning needs', () => {
    // Not a general row copy. Whatever else Clubworx returns about a contact
    // stays out of probes/out/ by construction.
    expect(Object.keys(pickProbeRows([probeRow])[0]).sort()).toEqual([
      'contact_key',
      'email',
      'last_name',
    ]);
  });

  it('drops a row that matches the probe email but not a probe name', () => {
    // Someone else using noreply+wayfindertest@ is not this probe's record, and
    // reusing it would answer question 2 with a stranger's contact.
    expect(pickProbeRows([{ ...strangerRow, email: TEST_IDENTITY.email }])).toHaveLength(0);
  });

  it('recognises an existing contact even when the search omits its dob', () => {
    // Recognition is looser than writing on purpose. A list response is not
    // guaranteed to carry a date of birth, and a recogniser that demanded one
    // would miss the probe's own contacts and create three MORE permanent
    // records on every run. Too strict here is the expensive direction.
    expect(probeRow.dob).toBeUndefined();
    expect(pickProbeRows([probeRow])).toHaveLength(1);
  });

  it('still refuses to write a contact without a dob', () => {
    // The other half of that asymmetry: the write guard stays strict.
    expect(() => assertProbeIdentity(probeRow)).toThrow(/dob/i);
  });

  it('survives a response that is not a list', () => {
    expect(pickProbeRows(null)).toEqual([]);
    expect(pickProbeRows({ error: 'nope' })).toEqual([]);
  });
});

describe('plusTag', () => {
  it('reads the tag out of a plus-addressed email', () => {
    expect(plusTag('noreply+stmarys@urbanjungleirc.com')).toBe('stmarys');
  });

  it('returns null when there is no tag', () => {
    expect(plusTag('noreply@urbanjungleirc.com')).toBeNull();
  });
});
