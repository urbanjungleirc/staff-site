// Step 5 — the preview table, the permanence line, and what stops Apply.
//
// staff-site#72. Everything here is a pure function over what steps 3 and 4
// already produced plus the Clubworx check between them, so the whole screen
// can be walked without a network.

import { describe, expect, test } from 'vitest';
import {
  buildPreview,
  consequenceLine,
  matchDecision,
  permanenceLine,
  resolveMatch,
} from '../preview.js';

// A step-3 row, in the shape `review()` emits.
const row = (over = {}) => ({
  key: 3,
  lineNumbers: [3],
  bucket: 'record',
  state: 'clean',
  firstName: 'Alice',
  lastName: 'Smith',
  dob: '2011-03-12',
  raw: '',
  flags: [],
  needs: [],
  note: '',
  needsHuman: false,
  resolution: null,
  ...over,
});

// A `matchStudent()` result.
const match = (over = {}) => ({
  state: 'new',
  reason: 'no-candidates',
  contact: null,
  candidates: [],
  firstNameIsPreferred: false,
  ...over,
});

const contact = (over = {}) => ({
  contact_key: 'ck-1',
  first_name: 'Alice',
  last_name: 'Smith',
  dob: '2011-03-12',
  email: null,
  status: 'Prospect',
  status_view: 'prospects',
  ...over,
});

const selection = (over = {}) => ({
  events: [
    { event_id: 'a', event_name: 'School Session', event_start_at: '2026-09-01T09:00:00+08:00' },
    { event_id: 'b', event_name: 'School Session', event_start_at: '2026-09-08T09:00:00+08:00' },
  ],
  blockers: [],
  ready: true,
  sessions: 2,
  students: 1,
  bookings: 2,
  firstSession: '2026-09-01',
  lastSession: '2026-09-08',
  ...over,
});

const plan = (over = {}) => ({
  ok: true,
  plan: {
    membership_plan_id: 42,
    name: 'School Pass',
    membership_duration: '26 weeks',
    duration: { ok: true, count: 26, unit: 'week', raw: '26 weeks' },
    coverage_end: '2027-02-18',
  },
  ...over,
});

const build = (over = {}) =>
  buildPreview({
    rows: [row()],
    matches: { 3: match() },
    selection: selection(),
    plan: plan(),
    decisions: {},
    ...over,
  });

describe('the three state columns', () => {
  test('READ is the parse state and CLUBWORX the match state, kept apart', () => {
    // P2b made structural: reading *down* a column is the scan this screen
    // exists for, and folding the parse state into the student cell as a pill
    // is what makes that scan impossible.
    const preview = build();
    expect(preview.rows[0]).toMatchObject({
      name: 'Alice Smith',
      dob: '2011-03-12',
      read: 'clean',
      clubworx: 'new',
      outcome: 'will book ×2',
    });
  });

  test('a matched student books and creates nothing', () => {
    const preview = build({ matches: { 3: match({ state: 'matched', reason: 'first-name-matches', contact: contact() }) } });
    expect(preview.rows[0].clubworx).toBe('matched');
    expect(preview.rows[0].outcome).toBe('will book ×2');
    expect(preview.rows[0].contactKey).toBe('ck-1');
  });

  test('a row that still needs a human has no Clubworx state at all', () => {
    // It was never sent to the search — sending a row with a wrong or missing
    // date of birth is how the surname + DOB key gets poisoned for every later
    // term. So the cell is empty rather than guessing at `new`.
    const preview = build({
      rows: [row({ state: 'needs-confirmation', needsHuman: true, note: 'Check the birthday.' })],
      matches: {},
    });
    expect(preview.rows[0]).toMatchObject({ read: 'needs-confirmation', clubworx: '', outcome: 'blocked' });
  });

  test('a student the search never reached is pending, not new', () => {
    // `new` creates a permanent contact. An absent answer must never read as
    // one — that is a duplicate written on the strength of a request that was
    // never made.
    const preview = build({ matches: {} });
    expect(preview.rows[0].clubworx).toBe('pending');
    expect(preview.rows[0].outcome).toBe('blocked');
  });

  test('a search that failed says so on the row', () => {
    const preview = build({ matches: { 3: { error: 'Clubworx is busy' } } });
    expect(preview.rows[0].clubworx).toBe('error');
    expect(preview.rows[0].outcome).toBe('blocked');
    expect(preview.rows[0].note).toBe('Clubworx is busy');
  });

  test('rows keep step 3’s order, so the two tables read the same way down', () => {
    const preview = build({
      rows: [row({ key: 9, firstName: 'Zoe' }), row({ key: 2, firstName: 'Ada' })],
      matches: { 9: match(), 2: match() },
    });
    expect(preview.rows.map((r) => r.key)).toEqual([2, 9]);
  });
});

describe('resolving a match', () => {
  test('a name variant blocks until somebody decides', () => {
    const preview = build({
      matches: { 3: match({ state: 'name-variant', reason: 'first-name-differs', candidates: [contact({ first_name: 'Alexandra' })] }) },
    });
    expect(preview.rows[0].outcome).toBe('blocked');
    expect(preview.rows[0].needsHuman).toBe(true);
    expect(preview.rows[0].candidates).toHaveLength(1);
    expect(preview.ready).toBe(false);
  });

  test('a nickname column is named on the row, because it changes what the mismatch means', () => {
    const preview = build({
      matches: {
        3: match({
          state: 'name-variant',
          reason: 'first-name-differs',
          candidates: [contact({ first_name: 'Alexandra' })],
          firstNameIsPreferred: true,
        }),
      },
    });
    expect(preview.rows[0].note).toMatch(/preferred name/i);
  });

  test('choosing a candidate makes the row a match on that contact', () => {
    const decisions = resolveMatch({}, 3, { kind: 'use', contactKey: 'ck-1' });
    const preview = build({
      matches: { 3: match({ state: 'name-variant', reason: 'first-name-differs', candidates: [contact()] }) },
      decisions,
    });
    expect(preview.rows[0]).toMatchObject({ clubworx: 'matched', outcome: 'will book ×2', contactKey: 'ck-1' });
    expect(preview.rows[0].resolution).toBe('use');
    expect(preview.ready).toBe(true);
  });

  test('choosing to create anyway makes the row new, and says the record is permanent', () => {
    const decisions = resolveMatch({}, 3, { kind: 'create' });
    const preview = build({
      matches: { 3: match({ state: 'ambiguous', reason: 'duplicate-contacts', candidates: [contact(), contact({ contact_key: 'ck-2' })] }) },
      decisions,
    });
    expect(preview.rows[0].clubworx).toBe('new');
    expect(preview.totals.contacts).toBe(1);
    expect(consequenceLine(preview.rows[0])).toMatch(/permanent/);
  });

  test('a decision naming a contact the search did not offer is ignored', () => {
    // The candidate list is re-read every time the check runs. A decision that
    // outlived its candidates would otherwise attach a permanent pass to a
    // contact key nothing on screen ever showed.
    const decisions = resolveMatch({}, 3, { kind: 'use', contactKey: 'ck-gone' });
    const preview = build({
      matches: { 3: match({ state: 'name-variant', reason: 'first-name-differs', candidates: [contact()] }) },
      decisions,
    });
    expect(preview.rows[0].outcome).toBe('blocked');
  });

  test('a decision is taken back by resolving to null', () => {
    const log = resolveMatch({}, 3, { kind: 'use', contactKey: 'ck-1' });
    expect(resolveMatch(log, 3, null)).toEqual({});
  });

  test('resolveMatch never mutates the log it was handed', () => {
    const log = {};
    resolveMatch(log, 3, { kind: 'create' });
    expect(log).toEqual({});
  });

  test('matchDecision reads back what is in force on a row', () => {
    expect(matchDecision({ 3: { kind: 'create' } }, 3)).toEqual({ kind: 'create' });
    expect(matchDecision({}, 3)).toBe(null);
  });

  test('an unmatchable row cannot be resolved into existence', () => {
    // `unmatchable` means the identity key itself is missing — no DOB, or no
    // surname. Choosing a contact for it would be choosing on a birthday alone.
    const decisions = resolveMatch({}, 3, { kind: 'create' });
    const preview = build({ matches: { 3: match({ state: 'unmatchable', reason: 'no-dob' }) }, decisions });
    expect(preview.rows[0].outcome).toBe('blocked');
    expect(preview.rows[0].note).toMatch(/date of birth/i);
  });
});

describe('the per-row consequence', () => {
  test('a new student: two permanent records and the bookings', () => {
    const preview = build();
    expect(consequenceLine(preview.rows[0])).toBe(
      'create a contact (permanent) · grant a School Pass (permanent) · 2 bookings (cancellable)',
    );
  });

  test('a returning student creates nothing, and the pass is settled at Apply', () => {
    // D4 and D14: the membership is read immediately before its own write, so
    // the preview genuinely does not know. Saying "pass already active" here
    // would be a claim nothing checked.
    const preview = build({ matches: { 3: match({ state: 'matched', contact: contact() }) } });
    expect(consequenceLine(preview.rows[0])).toBe(
      'create nothing · pass checked at Apply · 2 bookings (cancellable)',
    );
  });

  test('a blocked row says why instead of what it would do', () => {
    const preview = build({ matches: { 3: match({ state: 'unmatchable', reason: 'no-surname' }) } });
    expect(consequenceLine(preview.rows[0])).toMatch(/surname/i);
    expect(consequenceLine(preview.rows[0])).not.toMatch(/bookings/);
  });
});

describe('the permanence line', () => {
  test('it counts the two permanent records apart from the cancellable one', () => {
    const rows = [row({ key: 1 }), row({ key: 2 }), row({ key: 3 }), row({ key: 4 })];
    const preview = build({
      rows,
      matches: Object.fromEntries(rows.map((r) => [r.key, match()])),
      selection: selection({ students: 4, bookings: 8 }),
    });
    expect(permanenceLine(preview)).toBe(
      'This will create 4 contacts (permanent) and 4 School Passes (permanent), '
      + 'and make 8 bookings (cancellable).',
    );
  });

  test('returning students are named as an unsettled pass rather than counted as one', () => {
    const rows = [row({ key: 1 }), row({ key: 2 })];
    const preview = build({
      rows,
      matches: { 1: match(), 2: match({ state: 'matched', contact: contact() }) },
      selection: selection({ students: 2, bookings: 4 }),
    });
    expect(permanenceLine(preview)).toContain('create 1 contact (permanent) and 1 School Pass (permanent)');
    expect(permanenceLine(preview)).toContain('1 returning student may also need a pass');
  });

  test('a re-run that creates nothing says exactly that', () => {
    // D13: the preview is the guard for a deliberate re-paste. It has to be
    // readable as "this writes nothing permanent", or the recovery path D5
    // prescribes looks identical to a mistake.
    const preview = build({ matches: { 3: match({ state: 'matched', contact: contact() }) } });
    expect(permanenceLine(preview)).toContain('create no contacts and no new School Passes');
  });

  test('with nothing bookable there is no sentence to make', () => {
    const preview = build({ matches: { 3: match({ state: 'unmatchable', reason: 'no-dob' }) } });
    expect(permanenceLine(preview)).toBe('');
  });
});

describe('the hard-stops before Apply lights up', () => {
  test('a clean run is ready', () => {
    const preview = build();
    expect(preview.ready).toBe(true);
    expect(preview.blockers.filter((b) => b.severity === 'block')).toEqual([]);
  });

  test('an unresolved plan is a hard-stop', () => {
    const preview = build({ plan: { ok: false, reason: 'plan-not-found', message: 'no membership plan is named "School Pass"' } });
    const blocker = preview.blockers.find((b) => b.kind === 'plan');
    expect(blocker.severity).toBe('block');
    expect(blocker.detail).toContain('no membership plan is named');
    expect(preview.ready).toBe(false);
  });

  test('an ambiguous plan name is a hard-stop, not a first match', () => {
    const preview = build({ plan: { ok: false, reason: 'plan-ambiguous', message: '2 membership plans are named "School Pass"' } });
    expect(preview.blockers.some((b) => b.kind === 'plan' && b.severity === 'block')).toBe(true);
  });

  test('a plan not looked up yet is a hard-stop too', () => {
    expect(build({ plan: null }).ready).toBe(false);
  });

  test('step 4’s blockers are carried, so Apply reads one list', () => {
    const preview = build({
      selection: selection({
        ready: false,
        blockers: [{ key: 'lead:b', kind: 'lead-time', severity: 'block', title: 'A session starts too soon to book', detail: '…', actions: [] }],
      }),
    });
    expect(preview.blockers.some((b) => b.kind === 'lead-time')).toBe(true);
    expect(preview.ready).toBe(false);
  });

  test('an unreadable plan duration warns and names the raw value, and never skips the check silently', () => {
    const preview = build({
      plan: plan({ plan: { ...plan().plan, membership_duration: 'a term', duration: { ok: false, raw: 'a term' }, coverage_end: null } }),
    });
    const warning = preview.blockers.find((b) => b.kind === 'plan-duration');
    expect(warning.severity).toBe('warn');
    expect(warning.detail).toContain('a term');
    expect(preview.ready).toBe(true);
  });

  test('a last session past the pass’s coverage is a hard-stop', () => {
    // ADR 0005: the test is *covers the last selected session*, not *active
    // today*. Every booking is written on a day the pass is live; the shortfall
    // surfaces weeks later at a session nobody is watching.
    const preview = build({
      selection: selection({ lastSession: '2027-06-01' }),
      plan: plan(),
    });
    const blocker = preview.blockers.find((b) => b.kind === 'coverage');
    expect(blocker.severity).toBe('block');
    expect(blocker.detail).toContain('2027-02-18');
    expect(blocker.detail).toContain('2027-06-01');
    expect(preview.ready).toBe(false);
  });

  test('a coverage end the Worker did not send is a warning, not a silent pass', () => {
    const preview = build({ plan: plan({ plan: { ...plan().plan, coverage_end: null } }) });
    expect(preview.blockers.some((b) => b.kind === 'coverage-unknown' && b.severity === 'warn')).toBe(true);
    expect(preview.ready).toBe(true);
  });

  test('a session exactly on the last covered day is allowed', () => {
    const preview = build({ selection: selection({ lastSession: '2027-02-18' }) });
    expect(preview.blockers.some((b) => b.kind === 'coverage')).toBe(false);
  });

  test('unresolved rows are one blocker naming them, not one blocker each', () => {
    const rows = [row({ key: 1, firstName: 'Ada' }), row({ key: 2, firstName: 'Zoe' })];
    const preview = build({
      rows,
      matches: {
        1: match({ state: 'ambiguous', reason: 'duplicate-contacts', candidates: [contact()] }),
        2: match({ state: 'ambiguous', reason: 'duplicate-contacts', candidates: [contact()] }),
      },
    });
    const blocker = preview.blockers.find((b) => b.kind === 'unresolved-matches');
    expect(blocker.severity).toBe('block');
    expect(blocker.detail).toContain('Ada');
    expect(blocker.detail).toContain('Zoe');
  });

  test('every student blocked is a hard-stop, even with sessions picked', () => {
    const preview = build({ matches: { 3: match({ state: 'unmatchable', reason: 'no-dob' }) } });
    expect(preview.blockers.some((b) => b.kind === 'nobody-to-book')).toBe(true);
  });

  test('the totals only count rows that would actually run', () => {
    const rows = [row({ key: 1 }), row({ key: 2 })];
    const preview = build({
      rows,
      matches: { 1: match(), 2: match({ state: 'ambiguous', reason: 'duplicate-contacts', candidates: [contact()] }) },
      selection: selection({ students: 2, bookings: 4 }),
    });
    expect(preview.totals).toMatchObject({ students: 1, contacts: 1, passes: 1, bookings: 2, blocked: 1 });
  });
});
