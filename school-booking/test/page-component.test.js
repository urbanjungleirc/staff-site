// The page's own component, driven without a DOM.
//
// Every method on `schoolBooking()` is plain JavaScript over the two modules —
// Alpine supplies reactivity and nothing else — so the whole of steps 1–3 can
// be walked here: pick a school, paste a list, declare a count, read it, fix a
// row, override the mapping. What this catches is the half the pure-module
// tests cannot see: a method calling an export that does not exist, passing the
// wrong shape, or leaving the component in a state the markup then renders.
//
// It is extracted from the page rather than duplicated, so a page that stops
// matching this file is a page that stops passing.

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as parser from '../parse.js';
import * as steps from '../steps.js';
import * as identity from '../identity.js';
import * as events from '../events.js';
import * as preview from '../preview.js';
import * as calendar from '../calendar.js';
import * as outcome from '../outcome.js';
import * as run from '../run.js';

const html = readFileSync(new URL('../../school-booking.html', import.meta.url), 'utf8');
const fixture = (name) =>
  readFileSync(new URL(`../../docs/school-lists/${name}`, import.meta.url), 'utf8');

const SPREADSHEET = fixture('fixture-2-spreadsheet.tsv'); // 6 students, headed, 3 columns
const VERTICAL = fixture('fixture-1-vertical.txt'); // 5 students, 6 fields each

// The page's whole inline script, evaluated here — the block the factory lives
// in, not just the factory, so a constant hoisted beside it comes too. Bounded
// by its own tags at both ends, so a future second block cannot be swept in.
const factorySource = (() => {
  const anchor = html.indexOf('function schoolBooking()');
  expect(anchor, 'schoolBooking() not found in the page').toBeGreaterThan(-1);
  const open = html.lastIndexOf('<script>', anchor) + '<script>'.length;
  return html.slice(open, html.indexOf('</script>', anchor));
})();

// eslint-disable-next-line no-new-func
const makeComponent = new Function(`${factorySource}\nreturn schoolBooking();`);

const SCHOOLS = [
  { tag: 'newman', email: 'noreply+newman@urbanjungleirc.com', contacts: 63 },
  { tag: 'harlow', email: 'noreply+harlow@urbanjungleirc.com', contacts: 4 },
];

// The four routes steps 1–5 read, all of them GETs, plus the two #73 writes.
// The GET half is asserted to stay a GET half: a write reaching Clubworx from
// any step before Apply is the fault this fixture exists to catch, and the
// `writes` counter below is what a step 1–5 test checks.
const EVENTS = [
  {
    event_id: 'e1', event_name: 'School Session — Newman', event_start_at: '2026-09-01T09:00:00+08:00',
    event_end_at: '2026-09-01T10:30:00+08:00', location_id: 'loc-1', location_name: 'Urban Jungle',
    free_class: false, event_full: false, spaces_available: 30,
    lead: { hoursAhead: 240, past: false, withinLeadTime: false, minLeadHours: 24, unreadable: false },
    bookable: true,
  },
  {
    event_id: 'e2', event_name: 'School Session — Newman', event_start_at: '2026-09-08T09:00:00+08:00',
    event_end_at: '2026-09-08T10:30:00+08:00', location_id: 'loc-1', location_name: 'Urban Jungle',
    free_class: false, event_full: false, spaces_available: 30,
    lead: { hoursAhead: 408, past: false, withinLeadTime: false, minLeadHours: 24, unreadable: false },
    bookable: true,
  },
  {
    event_id: 'e3', event_name: 'Open Climb', event_start_at: '2026-09-02T17:00:00+08:00',
    event_end_at: '2026-09-02T19:00:00+08:00', location_id: 'loc-1', location_name: 'Urban Jungle',
    free_class: false, event_full: false, spaces_available: 4,
    lead: { hoursAhead: 260, past: false, withinLeadTime: false, minLeadHours: 24, unreadable: false },
    bookable: true,
  },
];

// A Newman session that starts inside the lead time, ahead of the two above so
// `pickSeries` ticks all three. ADR 0007's whole subject.
const SOON = {
  event_id: 'e0', event_name: 'School Session — Newman', event_start_at: '2026-08-22T09:00:00+08:00',
  event_end_at: '2026-08-22T10:30:00+08:00', location_id: 'loc-1', location_name: 'Urban Jungle',
  free_class: false, event_full: false, spaces_available: 30,
  lead: { hoursAhead: 4, past: false, withinLeadTime: true, minLeadHours: 24, unreadable: false },
  bookable: false,
};

const PLAN = {
  ok: true,
  plan: {
    membership_plan_id: 'mp-school',
    name: 'School Pass',
    membership_duration: '26 weeks',
    duration: { ok: true, count: 26, unit: 'week', raw: '26 weeks' },
    coverage_end: '2027-02-18',
  },
};

// A clean `POST /student` answer for a student this run created: a permanent
// contact, a permanent pass, and two cancellable bookings.
const STUDENT_OK = {
  ok: true,
  outcome: 'complete',
  written: true,
  contact: { contact_key: 'c-new', state: 'created' },
  pass: { state: 'created-with-contact', expiration_date: null, detail: 'created with the contact' },
  bookings: [
    { event_id: 'e1', state: 'booked', booking_id: 'bk-1', bookingId: 'bk-1', shown: null },
    { event_id: 'e2', state: 'booked', booking_id: 'bk-2', bookingId: 'bk-2', shown: null },
  ],
  rollback: null,
  stranded: false,
  strandedDetail: null,
  warnings: [],
  requests: 8,
  reason: null,
  message: null,
};

const UNBOOK_OK = {
  ok: true,
  outcome: 'cancelled',
  reason: null,
  message: '2 booking(s) cancelled and confirmed gone',
  cancelled: 2,
  cancelledIds: ['bk-1', 'bk-2'],
  skipped: 0,
  failed: [],
  stillBooked: [],
  verified: true,
  requests: 3,
};

function component({
  schools = SCHOOLS,
  schoolsFail = false,
  eventList = EVENTS,
  eventsFail = false,
  plan = PLAN,
  candidatesFor = () => [],
  contactsFail = false,
  // #73's two write routes. `student` and `unbook` are called with the parsed
  // body and answer `{status, body}`, so a test can throttle the fifth student
  // or refuse one row without touching the engine's own tests.
  student = () => ({ status: 200, body: STUDENT_OK }),
  unbook = () => ({ status: 200, body: UNBOOK_OK }),
  restored = null,
} = {}) {
  const stored = new Map();
  if (restored) stored.set('uj-school-booking-run', JSON.stringify(restored));
  const listeners = [];
  const writes = [];
  globalThis.window = {
    schoolListParser: parser,
    schoolBookingSteps: steps,
    schoolBookingIdentity: identity,
    schoolBookingEvents: events,
    schoolBookingPreview: preview,
    schoolBookingCalendar: calendar,
    schoolBookingOutcome: outcome,
    schoolBookingRun: run,
    localStorage: {
      getItem: (k) => (stored.has(k) ? stored.get(k) : null),
      setItem: (k, v) => stored.set(k, String(v)),
      removeItem: (k) => stored.delete(k),
    },
    addEventListener: (name, fn) => listeners.push([name, fn]),
    removeEventListener: (name, fn) => {
      const at = listeners.findIndex(([n, f]) => n === name && f === fn);
      if (at > -1) listeners.splice(at, 1);
    },
  };
  globalThis.fetch = vi.fn(async (url, options) => {
    const target = String(url);
    if (target.includes('/api/clubworx/schools')) {
      if (schoolsFail) return { ok: false, status: 502, json: async () => ({ error: 'upstream' }) };
      return { ok: true, status: 200, json: async () => ({ ok: true, schools }) };
    }
    if (target.includes('/api/clubworx/events')) {
      if (eventsFail) return { ok: false, status: 502, json: async () => ({ error: 'the Clubworx read failed' }) };
      const query = new URL(target, 'https://example.test').searchParams.get('q') ?? '';
      const matched = query
        ? eventList.filter((e) => e.event_name.toLowerCase().includes(query.toLowerCase()))
        : eventList;
      return { ok: true, status: 200, json: async () => ({ ok: true, events: matched, total: eventList.length, truncated: false }) };
    }
    if (target.includes('/api/clubworx/plan')) {
      if (plan.ok) return { ok: true, status: 200, json: async () => plan };
      return { ok: false, status: 502, json: async () => ({ error: plan.message, reason: plan.reason }) };
    }
    if (target.includes('/api/clubworx/contacts')) {
      if (contactsFail) return { ok: false, status: 429, json: async () => ({ error: 'Clubworx is busy' }) };
      const params = new URL(target, 'https://example.test').searchParams;
      return {
        ok: true,
        status: 200,
        json: async () => ({ candidates: candidatesFor(params.get('last_name'), params.get('dob')) }),
      };
    }
    if (target.includes('/api/clubworx/student') || target.includes('/api/clubworx/unbook')) {
      const body = JSON.parse(options?.body ?? '{}');
      const route = target.includes('/unbook') ? 'unbook' : 'student';
      writes.push({ route, body });
      const answer = (route === 'unbook' ? unbook : student)(body, writes.length);
      return { ok: answer.status < 400, status: answer.status, json: async () => answer.body };
    }
    return { ok: true, status: 200, json: async () => ({ email: 'staff@urbanjungleirc.com' }) };
  });
  const app = makeComponent();
  app.__writes = writes;
  app.__listeners = listeners;
  app.__stored = stored;
  return app;
}

// init() kicks off two fetches without awaiting them — Alpine ignores what a
// component's init() returns, so the page has no reason to hand back a promise
// it would only be dropping. The wait belongs on this side.
const settled = async (app) => {
  app.init();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return app;
};

// The walk staff take: school, paste, count, read.
async function upToStepThree(app, { text = SPREADSHEET, count = '6', unknown = false } = {}) {
  await settled(app);
  app.tag = 'newman';
  app.go(1);
  app.rawPaste = text;
  app.countValue = count;
  app.countUnknown = unknown;
  app.readList();
  return app;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('bootstrap', () => {
  test('it loads the schools, and reads nothing else', async () => {
    const app = await settled(component());
    expect(app.bootstrapError).toBe('');
    expect(app.schools).toHaveLength(2);
    // One call, to the one route the ticket asks for. #71 asks for the school
    // list and nothing else; every other read is a page doing more than it
    // was asked to.
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(String(globalThis.fetch.mock.calls[0][0])).toContain('/api/clubworx/schools');
  });

  test('a failed schools read does not block step 1', async () => {
    // Typing a tag is a first-class route — it is how a school gets its first
    // one — so the list is an aid to reuse, never a permission to proceed.
    const app = await settled(component({ schoolsFail: true }));
    expect(app.schoolsState).toBe('error');
    expect(app.schoolsNote()).toContain('still type a tag');
    app.schoolQuery = 'Example Grammar';
    app.useTypedTag();
    expect(app.tag).toBe('examplegrammar');
    expect(app.marker()).toBe('noreply+examplegrammar@urbanjungleirc.com');
  });

  test('a missing module refuses out loud instead of pretending to check', async () => {
    globalThis.window = {
      schoolBookingSteps: steps,
      schoolBookingIdentity: identity,
      schoolBookingEvents: events,
      schoolBookingPreview: preview,
      schoolBookingCalendar: calendar,
    };
    globalThis.fetch = vi.fn();
    const app = await settled(makeComponent());
    expect(app.bootstrapError).toContain('list parser');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('step 1 — the school', () => {
  test('the picker offers the busiest tags first, and marks a new one as new', async () => {
    const app = await settled(component());
    expect(app.filteredSchools().map((s) => s.tag)).toEqual(['newman', 'harlow']);

    app.schoolQuery = 'new';
    expect(app.filteredSchools().map((s) => s.tag)).toEqual(['newman']);
    expect(app.knownTag(app.typedTag())).toBe(false); // 'new' is not 'newman'
    app.schoolQuery = 'Newman';
    expect(app.knownTag(app.typedTag())).toBe(true);
  });
});

describe('step 2 — the count gate holds the door', () => {
  test('the read button needs both a paste and a declaration', async () => {
    const app = await settled(component());
    app.tag = 'newman';
    expect(app.canRead()).toBe(false);
    app.rawPaste = SPREADSHEET;
    expect(app.canRead()).toBe(false);
    app.countValue = '6';
    expect(app.canRead()).toBe(true);
  });

  test('"I don\'t know" is enough on its own', async () => {
    const app = await settled(component());
    app.rawPaste = SPREADSHEET;
    app.countUnknown = true;
    expect(app.canRead()).toBe(true);
  });

  test('nothing is parsed before the count is answered', async () => {
    const app = await settled(component());
    app.rawPaste = SPREADSHEET;
    // The order is the whole point of P5 — a count displayed first is
    // anchoring theatre. Nothing exists to display until readList() runs.
    expect(app.parsed).toBeNull();
    expect(app.reviewed).toBeNull();
  });
});

describe('step 3 — reading the list', () => {
  test('a matching count reads clean and is ready to go on', async () => {
    const app = await upToStepThree(component());
    expect(app.stepIndex).toBe(2);
    expect(app.reviewed.counts.records).toBe(6);
    expect(app.reviewed.ready).toBe(true);
    expect(app.countLine()).toBe('You expected 6 students; we read 6.');
    expect(app.countTone()).toContain('emerald');
  });

  const redeclareAction = (app) =>
    app.reviewed.blockers.find((b) => b.kind === 'count-mismatch')
      ?.actions.find((a) => a.answers === 'redeclare');

  test('a mismatch blocks, and offers no re-declare until staff work the rows', async () => {
    const app = await upToStepThree(component(), { count: '21' });
    expect(app.reviewed.ready).toBe(false);
    // The gate is carried on the blocker rather than tested in the markup, so
    // there is no condition a template can forget.
    expect(redeclareAction(app)).toBeUndefined();

    app.dismissRow(2); // the first student
    expect(app.reviewed.counts.records).toBe(5);
    expect(redeclareAction(app)).toBeDefined();

    app.answerBlocker(redeclareAction(app));
    expect(app.countValue).toBe('5');
    expect(app.reviewed.ready).toBe(true);
  });

  test('putting the row back does not strand staff behind the gate', async () => {
    // Reported in use: the button reappears on every "put it back" except the
    // last, because the last one returns the count to what the parser read.
    // The worse version is the same rule one step on — re-declare, then undo,
    // and the mismatch has no way out but re-pasting the list.
    const app = await upToStepThree(component(), { count: '21' });
    app.dismissRow(2);
    app.dismissRow(3);
    expect(redeclareAction(app)).toBeDefined();

    app.undoRow(3);
    expect(redeclareAction(app)).toBeDefined();
    app.undoRow(2); // the last one back — the count now matches the parse again
    expect(app.reviewed.counts.records).toBe(6);
    expect(redeclareAction(app).label).toContain('6');
  });

  test('a fresh read locks the gate again', async () => {
    // The log is what remembers the edits, and a new read starts a new one.
    const app = await upToStepThree(component(), { count: '21' });
    app.dismissRow(2);
    expect(redeclareAction(app)).toBeDefined();

    app.go(1);
    app.rawPaste = SPREADSHEET.replace('Katie', 'Katherine');
    app.pasteChanged();
    app.countValue = '21';
    app.readList();
    expect(redeclareAction(app)).toBeUndefined();
  });

  test('the Back button does not walk around the count gate', async () => {
    // canRedeclare() refuses the in-place button; a Back to a freely editable
    // count box with the read count on screen is the same move, one click
    // further away, and it is the anchoring P5's ordering exists to prevent.
    const app = await upToStepThree(component(), { count: '21' });
    app.go(1);
    expect(app.countLocked()).toBe(true);

    // Editing the paste is a different list, so the declaration goes with it.
    app.rawPaste = `${SPREADSHEET}\nOtto\tBrennan\t4/3/2011`;
    app.pasteChanged();
    expect(app.countLocked()).toBe(false);
    expect(app.countValue).toBe('');
    expect(app.canRead()).toBe(false);
  });

  test('Back then forward keeps the rows already sorted out', async () => {
    const app = await upToStepThree(component(), { count: '6' });
    app.dismissRow(2);
    expect(app.reviewed.counts.records).toBe(5);

    app.go(1);
    app.readList();
    expect(app.stepIndex).toBe(2);
    expect(app.reviewed.counts.records).toBe(5);
  });

  test('the drawer and the sums say the same thing as the module', async () => {
    const app = await upToStepThree(component(), { text: VERTICAL, count: '5' });
    expect(app.ignoredSummary()).toBe('7 lines ignored before the first student');
    expect(app.ignoredColumnsLine()).toBe('3 columns ignored: FormGroup, YearLevel, Email.');
    expect(app.reconciliationLine()).toBe('5 students on 30 lines + 7 ignored + 0 unreadable = 37 lines pasted.');
  });

  test('every row gets an edit buffer, and none is created during a render', async () => {
    const app = await upToStepThree(component());
    for (const row of app.reviewed.rows) {
      expect(app.drafts[row.key], `draft for row ${row.key}`).toBeDefined();
    }
    const before = app.drafts;
    app.draftFor(app.reviewed.rows[0].key);
    app.draftFor(99); // a key that does not exist
    expect(app.drafts).toBe(before);
  });
});

describe('step 3 — the overrides', () => {
  test('swapping the name chips reverses the names', async () => {
    const app = await upToStepThree(component());
    expect(app.reviewed.rows[0].firstName).toBe('Katie');
    app.swapNames();
    expect(app.reviewed.rows[0].firstName).toBe('Fernsby');
    expect(app.reviewed.rows[0].lastName).toBe('Katie');
  });

  test('claiming a held column swaps the two roles rather than unnaming one', async () => {
    // A column can only be one field, so something has to give. Clearing the
    // other role leaves a named pair with one half missing, which the parser
    // refuses outright — and a refused list is what a broken chip looks like
    // from the front desk.
    const app = await upToStepThree(component());
    expect(app.currentColumns()).toMatchObject({ firstName: 0, lastName: 1, dob: 2 });
    app.setColumn('lastName', 0);
    expect(app.currentColumns()).toMatchObject({ firstName: 1, lastName: 0, dob: 2 });
    expect(app.reviewed.blockers.some((b) => b.kind === 'refusal')).toBe(false);
    expect(app.reviewed.rows[0]).toMatchObject({ firstName: 'Fernsby', lastName: 'Katie' });
  });

  test('a mapping that names no name columns never reaches the parser', async () => {
    const app = await upToStepThree(component());
    app.applyColumns({ dob: 2, firstName: null, lastName: null, combined: null });
    app.applyColumns({ dob: 2, firstName: 0, lastName: 0, combined: null });
    app.applyColumns({ dob: null, firstName: 0, lastName: 1, combined: null });
    expect(app.reviewed.blockers.some((b) => b.kind === 'refusal')).toBe(false);
    expect(app.currentColumns()).toMatchObject({ firstName: 0, lastName: 1, dob: 2 });
  });

  test('the chips describe whatever mapping is current, inferred or named', async () => {
    const app = await upToStepThree(component());
    expect(app.columnChips().map((c) => c.label)).toEqual(['First name', 'Surname', 'Birth date']);
    expect(app.columnChoices()).toHaveLength(3);

    app.setNameShape('combined');
    expect(app.columnChips().map((c) => c.roleLabel)).toEqual(['Name', 'Birthday']);
  });

  test('a forced block size drives the read, and reading it again undoes it', async () => {
    const app = await upToStepThree(component(), { text: VERTICAL, count: '5' });
    expect(app.reviewed.blockSize).toBe(6);

    app.setLayout('vertical');
    app.setBlockSize('3');
    expect(app.reviewed.blockSize).toBe(3);
    expect(app.reviewed.verdict).toContain('3 fields per student');

    app.clearOverrides();
    expect(app.reviewed.blockSize).toBe(6);
    expect(app.reviewed.counts.records).toBe(5);
  });

  test('a block size that cannot describe a list is put back, not just ignored', async () => {
    // Left in the box while the parse keeps the old block size, it is two
    // plausible states contradicting each other with nothing thrown — §16's
    // fault shape, which is the one this page is built to be careful about.
    const app = await upToStepThree(component(), { text: VERTICAL, count: '5' });
    const input = { value: '1' };
    app.setBlockSize('1', input);
    expect(input.value).toBe(6);
    app.setBlockSize('not a number', input);
    expect(input.value).toBe(6);
    expect(app.reviewed.blockSize).toBe(6);
    expect(app.reviewed.blockers.some((b) => b.kind === 'refusal')).toBe(false);
  });

  test('a combined name only splits onto a column that holds names', async () => {
    // `free[0]` would have picked whichever column was next — which is how
    // `Email` or `YearLevel` becomes somebody's permanent surname, obeyed
    // literally with nothing on screen to disagree with it.
    const app = await upToStepThree(component(), { text: VERTICAL, count: '5' });
    app.setNameShape('combined');
    expect(app.currentColumns().combined).toBe(0);

    const free = app.nameShapedFree();
    expect(free).not.toContain(2); // Dob
    expect(free).not.toContain(5); // Email — never name-shaped
    app.setNameShape('split');
    expect(app.currentColumns().lastName).toBe(free[0]);
    // The surname is the column headed LastName, and Email stays where it
    // belongs — named in the ignored list, which is P6's tell that the mapping
    // is right.
    expect(app.columnLabel(app.currentColumns().lastName)).toBe('LastName');
    expect(app.reviewed.ignoredColumns.map((c) => c.label)).toContain('Email');
  });

  test('an override drops the edit buffers, so confirm cannot undo it', async () => {
    // The buffers were seeded from the rows the *previous* read produced. One
    // that outlived its parse would hand the confirm button the pre-override
    // names — quietly reverting the swap for that one row, with nothing thrown
    // and the row looking confirmed.
    const app = await upToStepThree(component());
    expect(app.draftFor(2)).toMatchObject({ firstName: 'Katie', lastName: 'Fernsby' });

    app.swapNames();
    expect(app.draftFor(2)).toMatchObject({ firstName: 'Fernsby', lastName: 'Katie' });

    app.confirmRow(2);
    expect(app.reviewed.rows[0]).toMatchObject({ firstName: 'Fernsby', lastName: 'Katie' });
  });

  test('an acceptance survives an override — it lives in the resolution, not the buffer', async () => {
    const app = await upToStepThree(component(), {
      text: [
        ['First name', 'Surname', 'DOB'].join('\t'),
        ['Katie', 'Fernsby', '23/4/2010'].join('\t'),
        'Otto Brennan born 4 March 2011',
      ].join('\n'),
      count: '2',
    });
    Object.assign(app.draftFor(3), { firstName: 'Otto', lastName: 'Brennan', dob: '4/3/2011' });
    app.acceptRow(3);
    expect(app.reviewed.counts.records).toBe(2);

    app.swapNames();
    expect(app.reviewed.rows.find((r) => r.key === 3)).toMatchObject({
      bucket: 'record', firstName: 'Otto', lastName: 'Brennan',
    });
  });

  test('an override keeps the resolutions — the source lines did not move', async () => {
    const app = await upToStepThree(component());
    app.dismissRow(2);
    expect(app.reviewed.counts.records).toBe(5);
    app.swapNames();
    // A staff member who fixed the column mapping has not un-dismissed the
    // teacher they dismissed.
    expect(app.reviewed.counts.records).toBe(5);
    expect(app.reviewed.reconciled).toBe(true);
  });
});

describe('step 3 — resolving a row', () => {
  const WITH_STRAY_LINE = [
    ['First name', 'Surname', 'DOB'].join('\t'),
    ['Katie', 'Fernsby', '23/4/2010'].join('\t'),
    'Otto Brennan born 4 March 2011',
  ].join('\n');

  test('an unreadable line blocks, then becomes a student', async () => {
    const app = await upToStepThree(component(), { text: WITH_STRAY_LINE, count: '2' });
    expect(app.reviewed.ready).toBe(false);

    app.toggleRow(3);
    expect(app.expandedRow).toBe(3);
    Object.assign(app.draftFor(3), { firstName: 'Otto', lastName: 'Brennan', dob: '4/3/2011' });
    app.acceptRow(3);

    expect(app.reviewed.counts.records).toBe(2);
    expect(app.reviewed.ready).toBe(true);
    expect(app.expandedRow).toBeNull();
    const otto = app.reviewed.rows.find((r) => r.key === 3);
    expect(otto).toMatchObject({ bucket: 'record', firstName: 'Otto', dob: '2011-03-04' });
  });

  test('dismissing moves the line to the drawer, and it can be put back', async () => {
    const app = await upToStepThree(component(), { text: WITH_STRAY_LINE, count: '1' });
    app.dismissRow(3);
    expect(app.reviewed.ready).toBe(true);
    expect(app.ignoredSummary()).toBe('2 lines ignored — 1 before the first student, 1 you dismissed');
    expect(app.reviewed.reconciled).toBe(true);

    app.undoRow(3);
    expect(app.reviewed.ready).toBe(false);
    expect(app.reviewed.rows.find((r) => r.key === 3).bucket).toBe('error');
  });

  test('every blocker action dispatches to something', async () => {
    // The page dispatches on `answers` and knows no blocker kinds, so a kind
    // added in steps.js cannot arrive with no way out of it. This is the check
    // that the dispatch actually covers what steps.js emits.
    const KNOWN = ['nameOrder', 'dateOrientation', 'acknowledge', 'redeclare'];
    const pastes = [
      { text: WITH_STRAY_LINE, count: '9' },
      // Headerless: the name-order question.
      { text: [['Katie', 'Fernsby', '23/4/2010'].join('\t'), ['Tomas', 'Oakhill', '7/11/2010'].join('\t')].join('\n'), count: '2' },
      // Every date ambiguous, so nothing proves the orientation: the day/month
      // question, which is the one a wrong answer does not error on.
      {
        text: [
          ['First name', 'Surname', 'DOB'].join('\t'),
          ['Katie', 'Fernsby', '3/4/2010'].join('\t'),
          ['Tomas', 'Oakhill', '7/11/2010'].join('\t'),
        ].join('\n'),
        count: '2',
      },
    ];
    let seen = 0;
    for (const paste of pastes) {
      const app = await upToStepThree(component(), paste);
      for (const blocker of app.reviewed.blockers) {
        for (const action of blocker.actions) {
          expect(KNOWN, `${blocker.kind} offers "${action.answers}"`).toContain(action.answers);
          expect(typeof action.label).toBe('string');
          seen += 1;
        }
      }
    }
    expect(seen).toBeGreaterThan(3);
  });

  test('answering a list question clears its blocker', async () => {
    const headerless = [
      ['Katie', 'Fernsby', '23/4/2010'].join('\t'),
      ['Tomas', 'Oakhill', '7/11/2010'].join('\t'),
    ].join('\n');
    const app = await upToStepThree(component(), { text: headerless, count: '2' });
    const order = app.reviewed.blockers.find((b) => b.kind === 'name-order');
    expect(order.detail).toContain('Katie Fernsby / Fernsby Katie'); // P7: both ways

    app.answerBlocker(order.actions.find((a) => a.value === 'last-first'));
    expect(app.reviewed.blockers.some((b) => b.kind === 'name-order')).toBe(false);
    expect(app.reviewed.rows[0]).toMatchObject({ firstName: 'Fernsby', lastName: 'Katie' });
  });

  test('the row helpers describe every row without throwing', async () => {
    const app = await upToStepThree(component(), { text: WITH_STRAY_LINE, count: '2' });
    for (const row of app.reviewed.rows) {
      expect(typeof app.nameOf(row)).toBe('string');
      expect(app.laneFor(row)).toMatch(/^lane-/);
      expect(typeof app.stateTone(row)).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// Steps 4 and 5 (#72)
// ---------------------------------------------------------------------------

// Six students on three columns, so the counts below are the fixture's own.
// As far as step 4, with the dates seeded and nothing read yet.
const upToSessions = async (app, opts = {}) => {
  await upToStepThree(app, opts);
  app.toSessions();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return app;
};

// …and with the timetable actually read, which is now an explicit act. The
// window is widened past the fortnight the page seeds, because the fixture
// sessions are in September and the point of the seed is that it is short.
const withEvents = async (app, opts = {}) => {
  await upToSessions(app, opts);
  app.eventsFrom = '2026-08-21';
  app.eventsTo = '2026-12-31';
  await app.loadEvents();
  return app;
};

const upToPreview = async (app, opts = {}) => {
  await withEvents(app, opts);
  app.pickSeries('e1');
  await app.toPreview();
  return app;
};

describe('step 4 — the session picker', () => {
  test('going forward reads nothing until the operator says which dates', async () => {
    // A term-wide window is ~900 events at this gym — five requests of an
    // allowance the whole gym shares, spent on arrival before anybody has said
    // what they want, and a table too long to scan. So the dates are seeded
    // and the read waits.
    const app = await upToSessions(component());
    expect(app.stepIndex).toBe(3);
    expect(app.eventsState).toBe('idle');
    expect(app.events).toEqual([]);

    const reads = globalThis.fetch.mock.calls.map(([url]) => String(url));
    expect(reads.filter((u) => u.includes('/api/clubworx/events'))).toHaveLength(0);

    // Seeded, not blank: a starting point beats two empty boxes every time.
    expect(app.eventsFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(app.eventsTo).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(app.eventsTo > app.eventsFrom).toBe(true);
  });

  test('searching reads the window that is on screen', async () => {
    const app = await upToSessions(component());
    app.eventsFrom = '2026-09-01';
    app.eventsTo = '2026-09-30';
    await app.loadEvents();

    const read = globalThis.fetch.mock.calls.map(([url]) => String(url))
      .find((u) => u.includes('/api/clubworx/events'));
    // The window is a request parameter, not a filter: Clubworx refuses
    // `/events` with no window at all (#51), so the page always names one.
    expect(read).toContain('from=2026-09-01');
    expect(read).toContain('to=2026-09-30');
    expect(app.events).toHaveLength(3);
  });

  test('Search stays dark until both dates are real days', async () => {
    // A blank or impossible date is a Worker 422 the operator cannot act on —
    // "from and to are required, each as a real YYYY-MM-DD day" is a sentence
    // about a field they cannot see. Caught here instead.
    const app = await upToSessions(component());
    expect(app.canSearch()).toBe(true);

    app.eventsTo = '';
    expect(app.canSearch()).toBe(false);
    app.eventsTo = '2026-02-30'; // rolls forward rather than erroring
    expect(app.canSearch()).toBe(false);
    app.eventsTo = '2026-09-30';
    expect(app.canSearch()).toBe(true);

    // Backwards is not a window either.
    app.eventsFrom = '2026-10-30';
    expect(app.canSearch()).toBe(false);
  });

  test('a search that cannot run does not reach the network', async () => {
    const app = await upToSessions(component());
    app.eventsTo = '';
    await app.loadEvents();
    expect(globalThis.fetch.mock.calls.filter(([u]) => String(u).includes('/events'))).toHaveLength(0);
    expect(app.eventsState).toBe('idle');
  });

  test('the name filter is optional — a blank one still searches', async () => {
    const app = await upToSessions(component());
    expect(app.eventsQuery).toBe('');
    await app.loadEvents();
    const read = globalThis.fetch.mock.calls.map(([url]) => String(url))
      .find((u) => u.includes('/api/clubworx/events'));
    expect(read).not.toContain('q=');
    expect(app.events).toHaveLength(3);
  });

  test('step 3’s gates still hold the door', async () => {
    // A row nobody has sorted out must not reach a screen that books it.
    const app = await upToStepThree(component(), { count: '99' });
    expect(app.reviewed.ready).toBe(false);
    app.toSessions();
    expect(app.stepIndex).toBe(2);
  });

  test('picking the first session ticks its series and nothing else', async () => {
    const app = await withEvents(component());
    app.pickSeries('e1');
    expect(app.picked).toEqual(['e1', 'e2']); // Open Climb is a different series
    expect(app.selection.ready).toBe(true);
    expect(app.selection.bookings).toBe(12); // 2 sessions × 6 students
    expect(app.sessionsLine()).toBe('2 sessions × 6 students = 12 bookings.');
  });

  test('a tick can be taken off again, and the numbers follow', async () => {
    const app = await withEvents(component());
    app.pickSeries('e1');
    app.togglePick('e2');
    expect(app.picked).toEqual(['e1']);
    expect(app.selection.bookings).toBe(6);
  });

  test('nothing picked keeps the forward button dark', async () => {
    const app = await withEvents(component());
    expect(app.selection.ready).toBe(false);
    expect(app.selection.blockers.map((b) => b.kind)).toContain('no-events');
  });

  test('a session inside the lead time blocks, and its removal clears it', async () => {
    // D9: the fix is offered, never taken. The page removes the session when
    // the operator says so and never on its own initiative.
    const soon = {
      ...EVENTS[0],
      event_id: 'soon',
      lead: { hoursAhead: 3, past: false, withinLeadTime: true, minLeadHours: 24, unreadable: false },
      bookable: false,
    };
    const app = await withEvents(component({ eventList: [...EVENTS, soon] }));
    app.togglePick('e1');
    app.togglePick('soon');
    const blocker = app.selection.blockers.find((b) => b.kind === 'lead-time');
    expect(blocker).toBeTruthy();
    expect(app.selection.ready).toBe(false);

    app.answerSelection(blocker.actions[0]);
    expect(app.picked).toEqual(['e1']);
    expect(app.selection.ready).toBe(true);
  });

  test('an unbookable session is still shown, with its reason', async () => {
    const past = {
      ...EVENTS[0],
      event_id: 'gone',
      lead: { hoursAhead: -10, past: true, withinLeadTime: false, minLeadHours: 24, unreadable: false },
      bookable: false,
    };
    const app = await withEvents(component({ eventList: [past] }));
    expect(app.events).toHaveLength(1); // annotated, never filtered
    expect(app.eventLane(past)).toBe('lane-bad');
    expect(app.eventWarning(past)).toBe('Already started.');
    expect(app.eventWarningTone(past)).toBe('text-rose-700');
  });

  test('too few spaces warns without blocking', async () => {
    const app = await withEvents(component());
    app.togglePick('e3'); // Open Climb reports 4 spaces for 6 students
    expect(app.selection.blockers.some((b) => b.kind === 'spaces' && b.severity === 'warn')).toBe(true);
    expect(app.selection.ready).toBe(true);
  });

  test('searching by name re-reads and drops ticks the new window no longer holds', async () => {
    const app = await withEvents(component());
    app.togglePick('e3');
    app.eventsQuery = 'School Session';
    await app.loadEvents();
    expect(app.events.map((e) => e.event_id)).toEqual(['e1', 'e2']);
    // e3 is gone from the window, so the tick goes with it — a count that
    // disagrees with the table is how a group is booked into a session nobody
    // can see.
    expect(app.picked).toEqual([]);
  });

  test('a failed events read says so and leaves the picker empty rather than stale', async () => {
    const app = await withEvents(component({ eventsFail: true }));
    expect(app.eventsState).toBe('error');
    expect(app.eventsNote()).toContain('Could not read');
    expect(app.events).toEqual([]);
    expect(app.selection.ready).toBe(false);
  });

  test('a pasted id resolves against the loaded window, then waits to be confirmed', async () => {
    const app = await withEvents(component());
    app.pastedEventId = ' e1 ';
    app.usePastedId();
    expect(app.pastedIdOk).toBe(true);
    expect(app.pastedIdConfirmLine()).toContain('School Session');
    // Nothing is ticked until a human agrees this is the right class — §8.
    expect(app.picked).toEqual([]);
    app.confirmPastedId();
    expect(app.picked).toEqual(['e1', 'e2']);
  });

  test('an id outside the window never claims the id is wrong', async () => {
    // #97: `GET /events/:id` answers 404 for a real id and an invented one
    // alike, so nothing can tell them apart — and "no such event" sends staff
    // to re-check an id that is fine.
    const app = await withEvents(component());
    app.pastedEventId = '999999';
    app.usePastedId();
    expect(app.pastedIdOk).toBe(false);
    expect(app.pastedIdNote).toMatch(/window/i);
    expect(app.pastedIdNote).not.toMatch(/not found|no such/i);
    expect(app.picked).toEqual([]);
    // And it costs no request: the answer is already on screen.
    expect(globalThis.fetch.mock.calls.filter(([u]) => String(u).includes('event_id'))).toHaveLength(0);
  });
});

describe('the Clubworx check between 4 and 5', () => {
  test('it reads the plan once and each student once, and writes nothing', async () => {
    const app = await upToPreview(component());
    const reads = globalThis.fetch.mock.calls.map(([url]) => String(url));
    expect(reads.filter((u) => u.includes('/api/clubworx/plan'))).toHaveLength(1);
    expect(reads.filter((u) => u.includes('/api/clubworx/contacts'))).toHaveLength(6);

    // Every call a GET. Apply is #73; a POST from this page would be a write
    // nobody asked for, against records Clubworx cannot delete.
    for (const [, options] of globalThis.fetch.mock.calls) {
      expect(options?.method ?? 'GET').toBe('GET');
    }
  });

  test('the search is asked with both halves of the identity key', async () => {
    // A surname-less query walks ~60,000 contacts and concludes nothing; a
    // query with no birthday cannot tell siblings apart (§5).
    const app = await upToPreview(component());
    const contacts = globalThis.fetch.mock.calls
      .map(([url]) => String(url))
      .filter((u) => u.includes('/api/clubworx/contacts'));
    for (const url of contacts) {
      const params = new URL(url, 'https://example.test').searchParams;
      expect(params.get('last_name')).toBeTruthy();
      expect(params.get('dob')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(app.preview.rows.every((r) => r.clubworx === 'new')).toBe(true);
  });

  test('an existing contact comes back matched and creates nothing', async () => {
    const app = await upToPreview(component({
      candidatesFor: (lastName, dob) => (lastName === 'Fernsby'
        ? [{ contact_key: 'ck-1', first_name: 'Katie', last_name: 'Fernsby', dob, status_view: 'members' }]
        : []),
    }));
    const matched = app.preview.rows.filter((r) => r.clubworx === 'matched');
    expect(matched).toHaveLength(1);
    expect(matched[0].contactKey).toBe('ck-1');
    expect(app.preview.totals.contacts).toBe(5);
    expect(app.preview.totals.returning).toBe(1);
  });

  test('a failed search blocks that student rather than reporting them new', async () => {
    // `new` writes a contact Clubworx cannot delete. A request that failed must
    // never come out the other side as one.
    const app = await upToPreview(component({ contactsFail: true }));
    expect(app.preview.rows.every((r) => r.clubworx === 'error')).toBe(true);
    expect(app.preview.ready).toBe(false);
    expect(app.preview.totals.contacts).toBe(0);
  });

  test('an unresolved plan blocks the whole run', async () => {
    const app = await upToPreview(component({
      plan: { ok: false, reason: 'plan-ambiguous', message: '2 membership plans are named "School Pass"' },
    }));
    const blocker = app.preview.blockers.find((b) => b.kind === 'plan');
    expect(blocker.severity).toBe('block');
    expect(blocker.detail).toContain('2 membership plans');
    expect(app.preview.ready).toBe(false);
  });
});

describe('step 5 — the preview', () => {
  test('the permanence line counts the two permanent records apart from the bookings', async () => {
    const app = await upToPreview(component());
    expect(app.permanenceLine()).toBe(
      'This will create 6 contacts (permanent) and 6 School Passes (permanent), '
      + 'and make 12 bookings (cancellable).',
    );
    expect(app.preview.ready).toBe(true);
  });

  test('a re-run over students who all exist says it writes nothing permanent', async () => {
    // D13: the preview is the guard for a deliberate re-paste, so it has to be
    // readable as "this creates nothing" or the recovery path D5 prescribes
    // looks identical to a mistake.
    const app = await upToPreview(component({
      candidatesFor: (lastName, dob) => [{ contact_key: `ck-${lastName}`, first_name: null, last_name: lastName, dob }],
    }));
    // No first name on the candidate, so these come back as variants, not
    // matches — resolve them all the way a human would.
    for (const line of app.preview.rows) app.useContact(line.key, line.candidates[0].contact_key);
    expect(app.permanenceLine()).toContain('create no contacts and no new School Passes');
    expect(app.preview.ready).toBe(true);
  });

  test('a name variant blocks Apply until it is decided, either way', async () => {
    const app = await upToPreview(component({
      candidatesFor: (lastName, dob) => (lastName === 'Fernsby'
        ? [{ contact_key: 'ck-1', first_name: 'Katherine', last_name: 'Fernsby', dob, status_view: 'members' }]
        : []),
    }));
    const variant = app.preview.rows.find((r) => r.clubworx === 'name-variant');
    expect(variant.needsHuman).toBe(true);
    expect(app.preview.ready).toBe(false);

    app.useContact(variant.key, 'ck-1');
    expect(app.preview.rows.find((r) => r.key === variant.key).clubworx).toBe('matched');
    expect(app.preview.ready).toBe(true);

    app.undoMatch(variant.key);
    expect(app.preview.ready).toBe(false);

    app.createAnyway(variant.key);
    expect(app.preview.rows.find((r) => r.key === variant.key).clubworx).toBe('new');
    expect(app.preview.ready).toBe(true);
  });

  test('the row helpers describe every preview row without throwing', async () => {
    const app = await upToPreview(component({
      candidatesFor: (lastName, dob) => (lastName === 'Fernsby'
        ? [{ contact_key: 'ck-1', first_name: 'Katherine', last_name: 'Fernsby', dob, status_view: 'members' }]
        : []),
    }));
    for (const line of app.preview.rows) {
      expect(typeof app.consequenceLine(line)).toBe('string');
      expect(typeof app.clubworxTone(line)).toBe('string');
      app.togglePreviewRow(line.key);
      expect(app.expandedPreview).toBe(line.key);
      app.togglePreviewRow(line.key);
      expect(app.expandedPreview).toBe(null);
    }
  });

  test('going back to the sessions and forward again re-checks rather than trusting stale answers', async () => {
    const app = await upToPreview(component());
    const before = globalThis.fetch.mock.calls.length;
    app.go(3);
    app.togglePick('e2');
    await app.toPreview();
    expect(globalThis.fetch.mock.calls.length).toBeGreaterThan(before);
    expect(app.preview.totals.bookings).toBe(6); // one session now
  });
});

describe('the check does not leave stale answers on screen', () => {
  test('a second run clears the first run’s preview before it moves', async () => {
    // Step 5 is the screen an operator reads to approve permanent writes. A
    // preview belonging to a different selection, on screen for even one
    // render, is the wrong sentence at the one moment it is being trusted.
    const app = await upToPreview(component());
    expect(app.preview.totals.bookings).toBe(12);

    app.go(3);
    app.togglePick('e2');
    const running = app.toPreview();
    expect(app.preview).toBe(null);
    expect(app.checkState).toBe('running');
    await running;
    expect(app.checkState).toBe('done');
    expect(app.preview.totals.bookings).toBe(6);
  });
});

describe('an unresolvable plan stops the run before it spends the allowance', () => {
  test('no student is read when the School Pass plan did not resolve', async () => {
    // §11 hard-stops the *run* on an unresolved plan, and the reads are not
    // free: 6 students is 18 requests of an allowance the whole gym shares,
    // and nothing caches them — so a run that cannot proceed would spend them
    // again on the next attempt. The plan is a Clubworx configuration fix, so
    // there is nothing the operator can do with the answers meanwhile.
    const app = await withEvents(component({
      plan: { ok: false, reason: 'plan-not-found', message: 'no membership plan is named "School Pass"' },
    }));
    app.pickSeries('e1');
    await app.toPreview();

    const reads = globalThis.fetch.mock.calls.map(([url]) => String(url));
    expect(reads.filter((u) => u.includes('/api/clubworx/contacts'))).toHaveLength(0);

    // And it still lands on step 5 saying why, rather than refusing in place
    // with no screen to read: the blocker is the answer.
    expect(app.stepIndex).toBe(4);
    expect(app.preview.blockers.some((b) => b.kind === 'plan' && b.severity === 'block')).toBe(true);
    expect(app.preview.ready).toBe(false);
    expect(app.checkState).toBe('done');
  });
});

describe('the pasted id is a shortcut past the search, never past the confirmation', () => {
  test('resolving offers the session for confirmation and ticks nothing yet', async () => {
    // §8: "The id is resolved and shown with its name, date and
    // `spaces_available` for confirmation before it can be selected."
    const app = await withEvents(component());
    app.pastedEventId = 'e1';
    app.usePastedId();

    expect(app.picked).toEqual([]);
    expect(app.pastedIdEvent).toMatchObject({ event_id: 'e1', spaces_available: 30 });
    expect(app.pastedIdConfirmLine()).toContain('School Session');
    expect(app.pastedIdConfirmLine()).toContain('2026-09-01');
    expect(app.pastedIdConfirmLine()).toContain('30'); // spaces_available, on screen
  });

  test('confirming ticks the series from that session', async () => {
    const app = await withEvents(component());
    app.pastedEventId = 'e1';
    app.usePastedId();
    app.confirmPastedId();
    expect(app.picked).toEqual(['e1', 'e2']);
    expect(app.pastedIdEvent).toBe(null);
  });

  test('it says out loud that confirming replaces what is already ticked', async () => {
    // It replaces because pasting an id is the same statement as "pick this
    // first". Silently discarding six ticked sessions is what makes that
    // surprising, so the sentence names the count before the click.
    const app = await withEvents(component());
    app.togglePick('e3');
    app.pastedEventId = 'e1';
    app.usePastedId();
    expect(app.pastedIdConfirmLine()).toMatch(/replace/i);
    expect(app.pastedIdConfirmLine()).toContain('1');
  });

  test('an unresolvable id offers nothing to confirm', async () => {
    const app = await withEvents(component());
    app.togglePick('e1');
    app.pastedEventId = '999999';
    app.usePastedId();
    expect(app.pastedIdEvent).toBe(null);
    expect(app.pastedIdNote).toMatch(/window/i);
    expect(app.picked).toEqual(['e1']); // and takes nothing away
  });

  test('a resolved session can be dismissed without being taken', async () => {
    const app = await withEvents(component());
    app.pastedEventId = 'e1';
    app.usePastedId();
    app.cancelPastedId();
    expect(app.pastedIdEvent).toBe(null);
    expect(app.picked).toEqual([]);
  });
});

describe('a preview cannot outlive the list it describes', () => {
  test('reopening a step 3 gate drops the preview rather than leaving it ready', async () => {
    // The step strip lets staff jump to any step already reached, so without
    // this a walk of 5 → 3 → (edit) → 5 lands on a preview that still says
    // "ready" about a list that has changed underneath it.
    const app = await upToPreview(component());
    expect(app.preview.ready).toBe(true);

    app.go(2);
    app.dismissRow(app.reviewed.rows[0].key); // a real edit: one student fewer

    expect(app.preview).toBe(null);
    expect(app.matches).toEqual({});
    expect(app.checkState).toBe('idle');
  });

  test('a match decision is dropped with it, not carried onto different rows', async () => {
    const app = await upToPreview(component({
      candidatesFor: (lastName, dob) => (lastName === 'Fernsby'
        ? [{ contact_key: 'ck-1', first_name: 'Katherine', last_name: 'Fernsby', dob, status_view: 'members' }]
        : []),
    }));
    const variant = app.preview.rows.find((r) => r.clubworx === 'name-variant');
    app.useContact(variant.key, 'ck-1');
    expect(app.decisions[variant.key]).toBeTruthy();

    app.go(2);
    app.dismissRow(app.reviewed.rows[0].key);
    expect(app.decisions).toEqual({});
  });

  test('a step 3 gate still open is a hard-stop on the preview itself', async () => {
    // Belt as well as braces: even a preview that was somehow built while a
    // gate was open reports that gate, because buildPreview carries them.
    const app = await withEvents(component());
    app.pickSeries('e1');
    await app.toPreview();
    expect(app.preview.ready).toBe(true);

    // Reopen the count gate the way staff would, then rebuild in place.
    app.countValue = '99';
    app.refresh();
    expect(app.preview).toBe(null);
    app.refreshPreview();
    expect(app.preview.blockers.some((b) => b.kind === 'count-mismatch')).toBe(true);
    expect(app.preview.ready).toBe(false);
  });
});

describe('a hand-set window can cut a series in half', () => {
  test('a series running up to the loaded edge warns without blocking', async () => {
    const app = await upToSessions(component());
    app.eventsFrom = '2026-08-21';
    app.eventsTo = '2026-09-09'; // stops a day after the second session
    await app.loadEvents();
    app.pickSeries('e1');

    const warning = app.selection.blockers.find((b) => b.kind === 'series-reach');
    expect(warning.severity).toBe('warn');
    expect(warning.detail).toContain('2026-09-15'); // the session it cannot see
    expect(app.selection.ready).toBe(true);
  });

  test('a window that reaches past the series says nothing', async () => {
    const app = await withEvents(component());
    app.pickSeries('e1');
    expect(app.selection.blockers.some((b) => b.kind === 'series-reach')).toBe(false);
  });

  test('editing the dates without searching does not clear the warning', async () => {
    // The warning is about the window that was *read*. Typing a wider date into
    // the box changes nothing until Search is pressed, and a warning that
    // cleared on the keystroke would be answered by the one action that does
    // not answer it.
    const app = await upToSessions(component());
    app.eventsFrom = '2026-08-21';
    app.eventsTo = '2026-09-09';
    await app.loadEvents();
    app.pickSeries('e1');
    expect(app.selection.blockers.some((b) => b.kind === 'series-reach')).toBe(true);

    app.eventsTo = '2026-12-31';
    app.refreshSelection();
    expect(app.selection.blockers.some((b) => b.kind === 'series-reach')).toBe(true);

    await app.loadEvents();
    app.pickSeries('e1');
    expect(app.selection.blockers.some((b) => b.kind === 'series-reach')).toBe(false);
  });
});

describe('the house date picker', () => {
  test('it opens on the month already chosen, and closes on a pick', async () => {
    const app = await upToSessions(component());
    app.eventsFrom = '2026-09-15';

    app.toggleDatePicker('from');
    expect(app.datePicker).toBe('from');
    expect(app.monthLabel()).toBe('September 2026');
    expect(app.monthCells().find((c) => c.iso === '2026-09-15').selected).toBe(true);

    app.pickDay('2026-09-01');
    expect(app.eventsFrom).toBe('2026-09-01');
    expect(app.datePicker).toBe(null);
  });

  test('clicking the same trigger again closes it', async () => {
    const app = await upToSessions(component());
    app.toggleDatePicker('to');
    expect(app.datePicker).toBe('to');
    app.toggleDatePicker('to');
    expect(app.datePicker).toBe(null);
  });

  test('opening one picker replaces the other, never both at once', async () => {
    const app = await upToSessions(component());
    app.toggleDatePicker('from');
    app.toggleDatePicker('to');
    expect(app.datePicker).toBe('to');
  });

  test('a close meant for the other picker leaves this one alone', async () => {
    // The runtime half of #106's fix. Both pickers have an outside-handler, so
    // a click on one trigger fires the other's — and a close that did not
    // check which picker it spoke for would shut the one just opened. That is
    // the bug that shipped: the picker opened and closed on the same click,
    // and nothing threw.
    const app = await upToSessions(component());
    app.toggleDatePicker('from');
    app.closeDatePicker('to');
    expect(app.datePicker).toBe('from');

    app.closeDatePicker('from');
    expect(app.datePicker).toBe(null);
  });

  test('a close with no picker named shuts whatever is open', async () => {
    // Which is what picking a day and re-clicking a trigger both want.
    const app = await upToSessions(component());
    app.toggleDatePicker('to');
    app.closeDatePicker();
    expect(app.datePicker).toBe(null);
  });

  test('the months walk, and roll the year', async () => {
    const app = await upToSessions(component());
    app.eventsFrom = '2026-12-01';
    app.toggleDatePicker('from');
    app.stepMonth(1);
    expect(app.monthLabel()).toBe('January 2027');
    app.stepMonth(-1);
    expect(app.monthLabel()).toBe('December 2026');
  });

  test('the last session may not precede the first, and the first is not capped by it', async () => {
    // One bound reads as a fact — a last session before the first is not a
    // window — and the other read as a cage: `from` capped at `to` meant the
    // seeded fortnight was all the picker offered, with nothing explaining it
    // (#108). So only the first of these holds.
    const app = await upToSessions(component());
    app.eventsFrom = '2026-09-10';
    app.eventsTo = '2026-09-20';

    app.toggleDatePicker('to');
    const to = (iso) => app.monthCells().find((c) => c.iso === iso).disabled;
    expect(to('2026-09-09')).toBe(true);  // before `from`
    expect(to('2026-09-10')).toBe(false); // `from` itself is fair game
    expect(to('2026-09-30')).toBe(false);

    app.toggleDatePicker('from');
    const from = (iso) => app.monthCells().find((c) => c.iso === iso).disabled;
    expect(from('2026-09-21')).toBe(false); // past `to`, and allowed
    expect(from('2026-09-30')).toBe(false);
  });

  test('the trigger shows a written date, not an ISO string', async () => {
    const app = await upToSessions(component());
    // en-AU's own short form, whatever that is on the runtime — spelled out
    // here so a change to it is a failing test rather than a surprise.
    expect(app.dayLabel('2026-09-15')).toBe('Tue, 15 Sept 2026');
    expect(app.dayLabel('')).toBe('Choose a date');
    expect(app.dayLabel('2026-02-30')).toBe('Choose a date');
  });

  test('a closed picker builds no grid', async () => {
    const app = await upToSessions(component());
    expect(app.monthCells()).toEqual([]);
  });

  test('picking through the picker leaves Search able to run', async () => {
    const app = await upToSessions(component());
    app.toggleDatePicker('from');
    app.pickDay('2026-09-01');
    app.toggleDatePicker('to');
    app.pickDay('2026-09-30');
    expect(app.canSearch()).toBe(true);

    await app.loadEvents();
    const read = globalThis.fetch.mock.calls.map(([url]) => String(url))
      .find((u) => u.includes('/api/clubworx/events'));
    expect(read).toContain('from=2026-09-01');
    expect(read).toContain('to=2026-09-30');
  });
});

describe('step 4 says each thing once', () => {
  test('the multiplication line stays away until there is a selection to multiply', async () => {
    // #71's lesson, re-learned: "No sessions picked yet." above a blocker
    // saying "No sessions picked" is two banners for one message, and the
    // repetition is what trains people to stop reading the region.
    const app = await withEvents(component());
    expect(app.selection.sessions).toBe(0);
    expect(app.selection.blockers.some((b) => b.kind === 'no-events')).toBe(true);

    app.pickSeries('e1');
    expect(app.selection.sessions).toBe(2);
    expect(app.sessionsLine()).toBe('2 sessions × 6 students = 12 bookings.');
  });
});

// ---------------------------------------------------------------------------
// ADR 0007 / #144 — a too-soon session an operator keeps
// ---------------------------------------------------------------------------

const withSoon = async (opts = {}) => {
  const app = await withEvents(component({ eventList: [SOON, ...EVENTS], ...opts }));
  app.pickSeries('e0'); // e0, e1, e2 — the whole Newman series
  return app;
};

const leadTimeBlocker = (app) => app.selection.blockers.find((b) => b.kind === 'lead-time');

describe('the lead-time override (ADR 0007, #144)', () => {
  test('a too-soon session still blocks, and now offers keeping it beside removing it', async () => {
    const app = await withSoon();
    expect(app.picked).toEqual(['e0', 'e1', 'e2']);
    expect(app.selection.ready).toBe(false);

    const blocker = leadTimeBlocker(app);
    expect(blocker.severity).toBe('block');
    expect(blocker.actions.map((a) => a.answers)).toEqual(['remove', 'acknowledge-lead-time']);
  });

  test('taking the second answer raises a confirmation rather than acting on it', async () => {
    // It is a confirmation, not a formality to click past: the whole safety of
    // this feature is a human agreeing to go and lift a restriction by hand.
    const app = await withSoon();
    app.answerSelection(leadTimeBlocker(app).actions[1]);

    expect(app.leadTimeConfirm).toBe('e0');
    expect(app.selection.ready).toBe(false);
    expect(leadTimeBlocker(app).severity).toBe('block');
  });

  test('the confirmation names the session and what happens if the restriction is not lifted', async () => {
    const app = await withSoon();
    app.answerSelection(leadTimeBlocker(app).actions[1]);

    const line = app.leadTimeConfirmLine();
    expect(line).toContain('School Session — Newman');
    expect(line).toContain('2026-08-22');
    expect(line).toMatch(/restriction/i);
    expect(line).toMatch(/Clubworx/);
    // The consequence, concretely: refusals, and the third in a row stops it.
    expect(line).toMatch(/every booking/i);
    expect(line).toMatch(/halt|stop/i);
  });

  test('cancelling leaves the session refusing, and nothing acknowledged', async () => {
    const app = await withSoon();
    app.answerSelection(leadTimeBlocker(app).actions[1]);
    app.cancelLeadTimeOverride();

    expect(app.leadTimeConfirm).toBe(null);
    expect(app.selection.ready).toBe(false);
    expect(app.selection.acknowledgedEventIds).toEqual([]);
  });

  test('confirming drops it to a warning, keeps it on screen, and un-darkens Apply', async () => {
    const app = await withSoon();
    app.answerSelection(leadTimeBlocker(app).actions[1]);
    app.confirmLeadTimeOverride();

    expect(app.leadTimeConfirm).toBe(null);
    const blocker = leadTimeBlocker(app);
    // Still listed. A session that vanishes once acknowledged is invisible and
    // unexplained — the shape D9 already rejected.
    expect(blocker).toBeTruthy();
    expect(blocker.severity).toBe('warn');
    expect(blocker.detail).toMatch(/restriction/i);
    expect(app.selection.ready).toBe(true);
    expect(app.selection.acknowledgedEventIds).toEqual(['e0']);
  });

  test('the picker row agrees with the blocker about severity', async () => {
    // §16's fault shape: two surfaces contradicting each other about whether a
    // run can proceed. The row asks the same module the report does.
    const app = await withSoon();
    const soon = app.events.find((e) => e.event_id === 'e0');
    expect(app.eventLane(soon)).toBe('lane-bad');
    expect(app.eventWarningTone(soon)).toBe('text-rose-700');

    app.answerSelection(leadTimeBlocker(app).actions[1]);
    app.confirmLeadTimeOverride();

    expect(app.eventLane(soon)).toBe('lane-need');
    expect(app.eventWarningTone(soon)).toBe('text-amber-700');
    expect(app.eventWarning(soon)).toMatch(/restriction/i);
  });

  test('an acknowledgement can be taken back, and the block comes back with it', async () => {
    const app = await withSoon();
    app.answerSelection(leadTimeBlocker(app).actions[1]);
    app.confirmLeadTimeOverride();
    expect(app.selection.ready).toBe(true);

    // Still two answers, the removal first — an acknowledged session keeps it.
    const answers = leadTimeBlocker(app).actions;
    expect(answers.map((a) => a.answers)).toEqual(['remove', 'unacknowledge-lead-time']);

    app.answerSelection(answers[1]);
    expect(leadTimeBlocker(app).severity).toBe('block');
    expect(app.selection.ready).toBe(false);
    expect(app.selection.acknowledgedEventIds).toEqual([]);
  });

  test('acknowledging one of two too-soon sessions does not open the door', async () => {
    const second = { ...SOON, event_id: 'e0b', event_start_at: '2026-08-22T13:00:00+08:00' };
    const app = await withEvents(component({ eventList: [SOON, second, ...EVENTS] }));
    app.pickSeries('e0');
    expect(app.picked).toEqual(['e0', 'e0b', 'e1', 'e2']);

    app.askLeadTimeOverride('e0');
    app.confirmLeadTimeOverride();
    expect(app.selection.ready).toBe(false);
    expect(app.selection.acknowledgedEventIds).toEqual(['e0']);

    // Per session, throughout. There is no control that clears them all.
    app.askLeadTimeOverride('e0b');
    app.confirmLeadTimeOverride();
    expect(app.selection.ready).toBe(true);
    expect(app.selection.acknowledgedEventIds).toEqual(['e0', 'e0b']);
  });

  test('un-ticking an acknowledged session withdraws it, and ticking it again asks again', async () => {
    // The statement is about a session in this run. A session that comes back
    // pre-forgiven by a confirmation nobody re-took is the one thing the
    // confirmation exists to prevent.
    const app = await withSoon();
    app.askLeadTimeOverride('e0');
    app.confirmLeadTimeOverride();
    app.togglePick('e0');

    expect(app.picked).toEqual(['e1', 'e2']);
    expect(app.selection.acknowledgedEventIds).toEqual([]);

    app.togglePick('e0');
    expect(app.picked).toContain('e0');
    expect(leadTimeBlocker(app).severity).toBe('block');
    expect(app.selection.ready).toBe(false);
  });

  test('removing an acknowledged session from its own blocker withdraws the statement too', async () => {
    // The removal and the checkbox are the same act, so they cannot leave the
    // log in two different states.
    const app = await withSoon();
    app.askLeadTimeOverride('e0');
    app.confirmLeadTimeOverride();

    app.answerSelection(leadTimeBlocker(app).actions[0]); // Remove this session
    expect(app.picked).toEqual(['e1', 'e2']);
    expect(app.leadTimeAcknowledgements).toEqual({});
    expect(app.selection.ready).toBe(true);
  });

  test('a re-search cannot resurrect an acknowledgement for a session it dropped', async () => {
    // The tick is already dropped when a window no longer holds the session
    // (loadEvents), and the statement about it goes with it. Otherwise the
    // session comes back ticked-and-forgiven by a decision nobody re-took.
    const list = [SOON, ...EVENTS];
    const app = await withEvents(component({ eventList: list }));
    app.pickSeries('e0');
    app.askLeadTimeOverride('e0');
    app.confirmLeadTimeOverride();
    expect(app.selection.ready).toBe(true);

    list.shift(); // a narrower window, without the too-soon session
    await app.loadEvents();
    expect(app.picked).toEqual(['e1', 'e2']);

    list.unshift(SOON); // and back again
    await app.loadEvents();
    app.pickSeries('e0');
    expect(leadTimeBlocker(app).severity).toBe('block');
    expect(app.selection.ready).toBe(false);
  });

  test('an unreadable or already-started session is never overridable', async () => {
    const broken = {
      ...SOON, event_id: 'x1', event_name: 'School Session — Harlow', event_start_at: 'whenever',
      lead: { hoursAhead: null, past: null, withinLeadTime: null, minLeadHours: 24, unreadable: true },
    };
    const past = {
      ...SOON, event_id: 'x2', event_name: 'School Session — Harlow', event_start_at: '2026-08-01T09:00:00+08:00',
      lead: { hoursAhead: -480, past: true, withinLeadTime: false, minLeadHours: 24, unreadable: false },
    };
    const app = await withEvents(component({ eventList: [broken, past, ...EVENTS] }));
    app.picked = ['x1', 'x2'];
    app.refreshSelection();

    for (const kind of ['unreadable-session', 'past-session']) {
      const blocker = app.selection.blockers.find((b) => b.kind === kind);
      expect(blocker.severity).toBe('block');
      expect(blocker.actions.map((a) => a.answers)).toEqual(['remove']);
    }
    expect(app.selection.ready).toBe(false);
  });
});

describe('the override reaches the wire (#144)', () => {
  test('every student carries the acknowledged ids', async () => {
    const app = await withSoon();
    app.askLeadTimeOverride('e0');
    app.confirmLeadTimeOverride();
    await app.toPreview();
    app.askApply();
    await app.apply();

    expect(app.__writes).toHaveLength(6);
    for (const write of app.__writes) {
      expect(write.body.lead_time_acknowledged_event_ids).toEqual(['e0']);
      // Narrowed, never switched off: the other two sessions are not on it.
      expect(write.body.events.map((e) => e.event_id)).toEqual(['e0', 'e1', 'e2']);
    }
  });

  test('a run nobody overrode sends no acknowledgement key at all', async () => {
    const app = await upToApply(component());
    expect(app.__writes).toHaveLength(6);
    for (const write of app.__writes) {
      expect(write.body).not.toHaveProperty('lead_time_acknowledged_event_ids');
    }
  });
});

describe('the lifted sessions are named on the confirmation step (#145)', () => {
  const SOON_LABEL = 'School Session — Newman, 2026-08-22';

  test('the run consequence names the session whose restriction was lifted', async () => {
    const app = await withSoon();
    app.askLeadTimeOverride('e0');
    app.confirmLeadTimeOverride();
    await app.toPreview();

    const line = app.liftedRestrictionsLine();
    // The same label the picker and the blocker use, not a second spelling.
    expect(line).toContain(SOON_LABEL);
    expect(app.selection.blockers.find((b) => b.kind === 'lead-time').detail)
      .toContain(SOON_LABEL);
    expect(line).toMatch(/restriction/i);
    expect(line).toMatch(/fail/i);
  });

  test('a run nobody overrode says nothing at all', async () => {
    const app = await upToPreview(component());
    expect(app.liftedRestrictionsLine()).toBe('');
    // And the permanence sentence is still there beside the silence.
    expect(app.permanenceLine()).not.toBe('');
  });

  test('the permanence sentence is unchanged by an override', async () => {
    const app = await withSoon();
    app.askLeadTimeOverride('e0');
    app.confirmLeadTimeOverride();
    await app.toPreview();
    const withOverride = app.permanenceLine();
    expect(withOverride).not.toBe('');

    // The same run, one acknowledgement lighter. What the run writes has not
    // changed, so the sentence about what it writes must not have either — the
    // override changes what is said *beside* it, never it.
    app.takeBackLeadTimeOverride('e0');
    expect(app.permanenceLine()).toBe(withOverride);
    expect(app.liftedRestrictionsLine()).toBe('');
  });

  test("the acknowledged session's own warning still reaches the preview", async () => {
    const app = await withSoon();
    app.askLeadTimeOverride('e0');
    app.confirmLeadTimeOverride();
    await app.toPreview();

    const carried = app.preview.blockers.find((b) => b.kind === 'lead-time');
    expect(carried).toBeTruthy();
    expect(carried.severity).toBe('warn');
    expect(app.preview.ready).toBe(true);
  });

  test('taking the acknowledgement back on the preview clears the line, with no reload', async () => {
    const app = await withSoon();
    app.askLeadTimeOverride('e0');
    app.confirmLeadTimeOverride();
    await app.toPreview();
    expect(app.liftedRestrictionsLine()).toContain(SOON_LABEL);

    // The preview's own blocker list, which is the selection's carried verbatim.
    const takeBack = app.preview.blockers
      .find((b) => b.kind === 'lead-time')
      .actions.find((a) => a.answers === 'unacknowledge-lead-time');
    app.answerSelection(takeBack);

    expect(app.liftedRestrictionsLine()).toBe('');
    expect(app.preview.ready).toBe(false);
  });

  test('and re-taking it there brings the line back, still without a reload', async () => {
    // The only way onto step 5 is with every block cleared, so an override can
    // never be *first* taken from here — but it can be taken back and re-taken,
    // and both directions have to reach this line.
    const app = await withSoon();
    app.askLeadTimeOverride('e0');
    app.confirmLeadTimeOverride();
    await app.toPreview();

    app.takeBackLeadTimeOverride('e0');
    expect(app.liftedRestrictionsLine()).toBe('');

    app.askLeadTimeOverride('e0');
    app.confirmLeadTimeOverride();
    expect(app.liftedRestrictionsLine()).toContain(SOON_LABEL);
    expect(app.preview.ready).toBe(true);
  });

  test('two lifted sessions are both named', async () => {
    const second = { ...SOON, event_id: 'e0b', event_start_at: '2026-08-22T13:00:00+08:00' };
    const app = await withEvents(component({ eventList: [SOON, second, ...EVENTS] }));
    app.pickSeries('e0');
    app.askLeadTimeOverride('e0');
    app.confirmLeadTimeOverride();
    app.askLeadTimeOverride('e0b');
    app.confirmLeadTimeOverride();
    await app.toPreview();

    const line = app.liftedRestrictionsLine();
    expect(line).toMatch(/^2 sessions /);
    expect(line.split(SOON_LABEL).length - 1).toBe(2);
  });

  test('an acknowledgement taken back at the SELECTION step reaches the preview', async () => {
    // The criterion names step 4 specifically. Walking back there with a live
    // preview is the path a real operator takes — approve, hesitate, go back —
    // and it is the one `afterSelectionChange` exists for.
    const app = await withSoon();
    app.askLeadTimeOverride('e0');
    app.confirmLeadTimeOverride();
    await app.toPreview();
    expect(app.liftedRestrictionsLine()).toContain(SOON_LABEL);

    app.go(3); // back to the session picker, preview still built
    app.answerSelection(leadTimeBlocker(app).actions
      .find((a) => a.answers === 'unacknowledge-lead-time'));

    expect(app.preview).toBeTruthy();
    expect(app.liftedRestrictionsLine()).toBe('');
    expect(app.preview.ready).toBe(false);
  });

  test('un-ticking an acknowledged session at selection takes its name off too', async () => {
    // The tick and the statement are one act (#144). The name has to go with
    // them, or the run is approved against a session it will not book.
    const app = await withSoon();
    app.askLeadTimeOverride('e0');
    app.confirmLeadTimeOverride();
    await app.toPreview();

    app.go(3);
    app.togglePick('e0');

    expect(app.picked).toEqual(['e1', 'e2']);
    expect(app.liftedRestrictionsLine()).toBe('');
  });

  test('a tick changed anywhere rebuilds the preview, not just this line', async () => {
    // The staleness this line exposed was never only about this line. Step 5's
    // own blocker list offers "Remove this session", so a preview describing
    // the old booking count was reachable from the screen that approves the
    // run — and the permanence sentence is the number that matters there.
    const app = await withSoon();
    app.askLeadTimeOverride('e0');
    app.confirmLeadTimeOverride();
    await app.toPreview();

    const three = app.preview.totals.bookings;
    expect(app.preview.sessions).toHaveLength(3);

    // Straight off the preview's own blocker, the way an operator would.
    app.answerSelection(app.preview.blockers
      .find((b) => b.kind === 'lead-time')
      .actions.find((a) => a.answers === 'remove'));

    expect(app.preview.sessions).toHaveLength(2);
    expect(app.preview.totals.bookings).toBeLessThan(three);
    expect(app.permanenceLine()).toContain(`${app.preview.totals.bookings} bookings`);
    // And the removed session is not still named as lifted.
    expect(app.liftedRestrictionsLine()).toBe('');
  });

  test('the page renders it above the table and again where the run starts', () => {
    // Twice on purpose: the consequence area is where the run is approved and
    // the confirm block is where it is started, and the restriction has to be
    // off in Clubworx by the second one.
    expect(html.split('x-text="liftedRestrictionsLine()"').length - 1).toBe(2);
    // Its own x-show at both, so it is absent rather than an empty amber box.
    expect(html.split('x-show="liftedRestrictionsLine()"').length - 1).toBe(2);
    // And the permanence line still has its own, unchanged.
    expect(html).toContain('x-show="permanenceLine()"');
  });
});

describe('the override confirmation is on the page, and bound (#144)', () => {
  test('the blocker list renders it against the session it is about', () => {
    // Both blocker lists dispatch through `answerSelection`, so a confirmation
    // rendered on only one of them is an action that silently does nothing on
    // the other.
    const lists = html.split('@click="answerSelection(action)"').length - 1;
    expect(lists).toBe(2);
    expect(html.split('leadTimeConfirm === blocker.eventId').length - 1).toBe(lists);
  });

  test('the confirmation offers both ways out', () => {
    expect(html).toContain('confirmLeadTimeOverride()');
    expect(html).toContain('cancelLeadTimeOverride()');
    expect(html).toContain('leadTimeConfirmLine()');
  });
});

describe('the date picker bounds (#108)', () => {
  test('the first session cannot be in the past', async () => {
    // Nothing is bookable behind you — a past session is a hard-stop on the
    // selection anyway, so offering the date is offering a dead end.
    const app = await upToSessions(component());
    const today = app.todayDay();
    app.toggleDatePicker('from');

    const cells = app.monthCells().filter((c) => !c.empty);
    const past = cells.filter((c) => c.iso < today);
    const future = cells.filter((c) => c.iso >= today);
    expect(past.every((c) => c.disabled)).toBe(true);
    expect(future.every((c) => !c.disabled)).toBe(true);
  });

  test('the first session is not capped by the seeded fortnight', async () => {
    // The bug reported on #106: `from` was bounded above by `to`, and `to` is
    // seeded to today + 14 — so the picker offered a fortnight and nothing
    // explained why. A term starts when it starts; the second date follows the
    // first, not the other way round.
    const app = await upToSessions(component());
    app.toggleDatePicker('from');
    app.stepMonth(1);
    app.stepMonth(1);
    app.stepMonth(1); // three months past the seeded window
    expect(app.monthCells().filter((c) => !c.empty).every((c) => !c.disabled)).toBe(true);
  });

  test('moving the first session past the last carries the last with it', async () => {
    // Rather than leaving a backwards window with Search dark and nothing
    // saying which end to move. The field shows the new date, so nothing is
    // hidden by it.
    const app = await upToSessions(component());
    app.toggleDatePicker('from');
    app.pickDay('2027-03-01');
    expect(app.eventsFrom).toBe('2027-03-01');
    expect(app.eventsTo).toBe('2027-03-01');
    expect(app.canSearch()).toBe(true);
  });

  test('a first session inside the window leaves the last alone', async () => {
    const app = await upToSessions(component());
    const to = app.eventsTo;
    app.toggleDatePicker('from');
    app.pickDay(app.eventsFrom); // today, well before `to`
    expect(app.eventsTo).toBe(to);
  });

  test('the last session still cannot precede the first', async () => {
    const app = await upToSessions(component());
    app.eventsFrom = '2026-09-10';
    app.toggleDatePicker('to');
    const at = (iso) => app.monthCells().find((c) => c.iso === iso).disabled;
    expect(at('2026-09-09')).toBe(true);
    expect(at('2026-09-10')).toBe(false);

    // And no upper bound: three months on, everything is still selectable.
    app.stepMonth(3);
    expect(app.monthCells().filter((c) => !c.empty).every((c) => !c.disabled)).toBe(true);
  });
});

describe('the picker’s Today button (#108)', () => {
  test('it jumps the view to today and picks it', async () => {
    const app = await upToSessions(component());
    app.toggleDatePicker('from');
    app.stepMonth(6);
    app.goToday();
    expect(app.eventsFrom).toBe(app.todayDay());
    expect(app.datePicker).toBe(null);
  });

  test('it is offered only when today is a date this picker may take', async () => {
    // On the `to` picker with a first session in the future, today is behind
    // the minimum — so the button would be a control that cannot work.
    const app = await upToSessions(component());
    app.toggleDatePicker('from');
    expect(app.todayPickable()).toBe(true);

    app.eventsFrom = '2027-01-01';
    app.toggleDatePicker('to');
    expect(app.todayPickable()).toBe(false);
  });

  test('an unpickable Today does nothing rather than setting a refused date', async () => {
    const app = await upToSessions(component());
    app.eventsFrom = '2027-01-01';
    app.eventsTo = '2027-02-01';
    app.toggleDatePicker('to');
    app.goToday();
    expect(app.eventsTo).toBe('2027-02-01');
    expect(app.datePicker).toBe('to');
  });
});

// ---------------------------------------------------------------------------
// Step 6 — Apply, the run, and the cancel (#73)
// ---------------------------------------------------------------------------
// The engine's own behaviour — retries, the breaker, the throttle halt, the
// interlock — is pinned in `run.test.js` against a fake caller. What is checked
// here is the half only the page can get wrong: the gate in front of Apply, the
// single-flight lock, the payload actually put on the wire, and the record
// reaching storage per student rather than at the end.

const upToApply = async (app, opts = {}) => {
  await upToPreview(app, opts);
  app.askApply();
  await app.apply();
  return app;
};

describe('Apply — the gate in front of the first permanent write', () => {
  test('Apply asks before it runs, and says what the run costs', async () => {
    const app = await upToPreview(component());
    app.askApply();
    expect(app.confirming).toBe(true);
    // Nothing is written by asking.
    expect(app.__writes).toHaveLength(0);
    // §6: the allowance is gym-wide, so the cost is somebody else's problem too.
    expect(app.runCost()).toContain('shared with the whole gym');
    expect(app.runCost()).toMatch(/About \d+ Clubworx requests/);
  });

  test('standing down leaves the preview exactly as it was', async () => {
    const app = await upToPreview(component());
    app.askApply();
    app.standDown();
    expect(app.confirming).toBe(false);
    expect(app.__writes).toHaveLength(0);
    expect(app.stepIndex).toBe(4);
  });

  test('a blocked preview cannot be applied at all', async () => {
    const app = await upToPreview(component({
      candidatesFor: (lastName, dob) => (lastName === 'Fernsby'
        ? [{ contact_key: 'ck-1', first_name: 'Katherine', last_name: 'Fernsby', dob, status_view: 'members' }]
        : []),
    }));
    expect(app.preview.ready).toBe(false);
    app.askApply();
    await app.apply();
    expect(app.confirming).toBe(false);
    expect(app.__writes).toHaveLength(0);
  });

  test('steps 1–5 write nothing — every route they touch is a GET', async () => {
    const app = await upToPreview(component());
    expect(app.__writes).toHaveLength(0);
  });
});

describe('the run — what actually goes on the wire', () => {
  test('one call per student, to the write route, carrying the school marker', async () => {
    const app = await upToApply(component());
    expect(app.__writes).toHaveLength(6);
    expect(app.__writes.every((w) => w.route === 'student')).toBe(true);
    const [first] = app.__writes;
    expect(first.body.student.email).toBe('noreply+newman@urbanjungleirc.com');
    expect(first.body.membership_plan_id).toBe('mp-school');
    expect(first.body.membership_duration).toBe('26 weeks');
    expect(first.body.events.map((e) => e.event_id)).toEqual(['e1', 'e2']);
    // `new` — this run creates the contact. Sent explicitly rather than left
    // out, because absent and null must not be the same thing on this route.
    expect(first.body.contact_key).toBe(null);
  });

  test('the run lands on step 6 and reports in past tense', async () => {
    const app = await upToApply(component());
    expect(app.stepIndex).toBe(5);
    expect(app.runState).toBe('complete');
    expect(app.runRecords).toHaveLength(6);
    expect(app.resultLine()).toContain('6 contacts created (permanent)');
    expect(app.resultLine()).toContain('6 School Passes assigned (permanent)');
    expect(app.resultLine()).toContain('12 bookings made (can be cancelled)');
    expect(app.strandedWarning()).toBe('');
  });

  test('a second Apply mid-run is refused — D13’s single-flight lock', async () => {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const app = await upToPreview(component({
      student: () => ({ status: 200, body: STUDENT_OK }),
    }));
    // Hold the very first call open, then try to start a second run.
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async (...args) => { await held; return original(...args); });

    const running = app.apply();
    await Promise.resolve();
    await app.apply();
    release();
    await running;

    // Six students, once each — not twelve.
    expect(app.__writes).toHaveLength(6);
    globalThis.fetch = original;
  });

  test('the tab is guarded while the run is in flight, and released after', async () => {
    const app = await upToPreview(component());
    let duringRun = 0;
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async (...args) => {
      duringRun = app.__listeners.filter(([n]) => n === 'beforeunload').length;
      return original(...args);
    });
    await app.apply();
    // A reload mid-run destroys the only record of contacts that cannot be
    // deleted, which is the one thing worth interrupting a page unload for.
    expect(duringRun).toBe(1);
    expect(app.__listeners.filter(([n]) => n === 'beforeunload')).toHaveLength(0);
    globalThis.fetch = original;
  });
});

describe('the record — D10', () => {
  test('it is written per student, not at the end of the run', async () => {
    const seen = [];
    const app = await upToPreview(component({
      student: (body, n) => {
        seen.push(JSON.parse(app.__stored.get('uj-school-booking-run') ?? '{"records":[]}').records.length);
        return { status: 200, body: STUDENT_OK };
      },
    }));
    await app.apply();
    // Before each call, storage already holds every student that came before.
    expect(seen).toEqual([0, 1, 2, 3, 4, 5]);
    expect(JSON.parse(app.__stored.get('uj-school-booking-run')).records).toHaveLength(6);
  });

  test('a run left in this browser is offered on the way back in, never opened', async () => {
    const saved = {
      at: '2026-08-21T09:00:00+08:00',
      school: 'newman',
      state: 'complete',
      records: [{ key: 1, name: 'Ada Lovelace', state: 'booked', bookings: [], cancel: null }],
    };
    const app = await settled(component({ restored: saved }));
    expect(app.restored).not.toBe(null);
    expect(app.restoredLine()).toContain('1 student');
    expect(app.restoredLine()).toContain('newman');
    // Offered — the operator is still on step 1, not looking at a result table
    // they may mistake for the run they just did.
    expect(app.stepIndex).toBe(0);

    app.openRestored();
    expect(app.stepIndex).toBe(5);
    expect(app.runRecords).toHaveLength(1);
  });

  test('discarding it clears the browser copy too, not just the banner', async () => {
    const app = await settled(component({
      restored: { at: 'x', records: [{ key: 1, name: 'Ada', bookings: [] }] },
    }));
    app.discardRestored();
    expect(app.restored).toBe(null);
    expect(app.__stored.get('uj-school-booking-run')).toBe(undefined);
  });

  test('the copy staff keep carries the booking ids a hand-fix needs', async () => {
    const app = await upToApply(component());
    const text = app.recordText();
    expect(text).toContain('bk-1');
    expect(text).toContain('newman');
    expect(JSON.parse(text).students).toHaveLength(6);
  });
});

describe('the run reports the bad outcomes honestly', () => {
  test('a throttle halts the whole run and says the cause may be elsewhere', async () => {
    const app = await upToPreview(component({
      student: (body, n) => (n <= 2
        ? { status: 200, body: STUDENT_OK }
        : { status: 429, body: { outcome: 'failed', reason: 'throttled', written: false } }),
    }));
    // The backoff is a real 20-second wait in the page (D8's floor, sized on
    // #51's measured ~18 s). Driven with fake timers rather than shortened, so
    // what runs here is what runs in production.
    vi.useFakeTimers();
    const running = app.apply();
    await vi.runAllTimersAsync();
    await running;
    vi.useRealTimers();

    expect(app.runState).toBe('halted');
    expect(app.runReason).toBe('throttled');
    expect(app.runMessage).toContain('another system');
    // Two students done, the third attempted twice, and nobody after it sent.
    expect(app.__writes).toHaveLength(4);
    // The table still holds all six — D11's row set survives the halt, so the
    // screen shows where the run got to rather than a shorter list.
    expect(app.runRecords).toHaveLength(6);
    expect(app.runRecords.filter((r) => r.state === 'not run')).toHaveLength(4);
    expect(app.runRemaining).toBe(3);
    expect(app.resultLine()).toContain('2 contacts created (permanent)');
    expect(app.resultLine()).toContain('4 not run');
  });

  test('a stranded student is named on screen, not buried in a count', async () => {
    const app = await upToPreview(component({
      student: (body, n) => (n === 1
        ? {
          status: 200,
          body: {
            ...STUDENT_OK,
            ok: false,
            outcome: 'abandoned',
            reason: 'booking-refused',
            message: 'Sorry, this class has no free spaces available.',
            stranded: true,
            strandedDetail: 'This student has a contact and a School Pass and no bookings from this run.',
            bookings: [],
          },
        }
        : { status: 200, body: STUDENT_OK }),
    }));
    await app.apply();
    expect(app.strandedWarning()).toContain('a contact and a pass but no bookings');
    expect(app.runRecords[0].state).toBe('stranded');
    // The run carried on — one abandoned student is data, not a systemic halt.
    expect(app.runState).toBe('complete');
  });
});

describe('cancelling — D12, and never called Undo', () => {
  test('the control counts only what this run booked', async () => {
    const app = await upToApply(component());
    expect(app.cancellableCount()).toBe(12);
  });

  test('a re-run over students who were already booked offers nothing to cancel', async () => {
    // Booking is idempotent, so a re-run marks rows `already booked` — and a
    // cancel scoped to the whole row set would delete bookings this run did
    // not make, possibly ones a real member made themselves (#50).
    const app = await upToApply(component({
      student: () => ({
        status: 200,
        body: {
          ...STUDENT_OK,
          contact: { contact_key: 'c-old', state: 'matched' },
          pass: { state: 'covering', expiration_date: '2027-02-18', detail: 'already covers' },
          bookings: [
            { event_id: 'e1', state: 'already booked', booking_id: null, bookingId: null, shown: null },
            { event_id: 'e2', state: 'already booked', booking_id: null, bookingId: null, shown: null },
          ],
        },
      }),
    }));
    expect(app.cancellableCount()).toBe(0);
    app.askCancel();
    expect(app.cancelConfirming).toBe(false);
    await app.cancelRun();
    expect(app.__writes.filter((w) => w.route === 'unbook')).toHaveLength(0);
  });

  test('a student D3 already rolled back offers nothing, and is never re-sent', async () => {
    // The Worker cancelled these itself when it abandoned the student, and
    // hands the rows back unmutated — still reading `booked`, still carrying
    // their ids. Offering them would re-send ids that are already gone.
    const app = await upToApply(component({
      student: () => ({
        status: 200,
        body: {
          ...STUDENT_OK,
          ok: false,
          outcome: 'abandoned',
          reason: 'booking-refused',
          message: 'Sorry, this class has no free spaces available.',
          stranded: true,
          strandedDetail: 'This student has a contact and a School Pass and no bookings from this run.',
          rollback: {
            cancelled: 2, cancelledIds: ['bk-1', 'bk-2'], failed: [], stillBooked: [], verified: true, skipped: 0,
          },
        },
      }),
    }));

    expect(app.runRecords[0].state).toBe('stranded');
    // Three abandoned students in a row is a systemic condition, so D7 stops it.
    expect(app.runState).toBe('halted');
    expect(app.runReason).toBe('consecutive-failures');

    expect(app.cancellableCount()).toBe(0);
    // And the table does not claim bookings that no longer exist.
    expect(app.resultLine()).toContain('0 bookings made');
    expect(app.resultLine()).toContain('6 bookings rolled back');
    expect(app.bookingRows(app.runRecords[0]).every((b) => b.state === 'rolled back')).toBe(true);

    await app.cancelRun();
    expect(app.__writes.filter((w) => w.route === 'unbook')).toHaveLength(0);
  });

  test('a cancel asks first, then sends one student per call', async () => {
    const app = await upToApply(component());
    app.askCancel();
    expect(app.cancelConfirming).toBe(true);
    await app.cancelRun();

    const unbooks = app.__writes.filter((w) => w.route === 'unbook');
    expect(unbooks).toHaveLength(6);
    expect(unbooks[0].body.contact_key).toBe('c-new');
    expect(unbooks[0].body.bookings.map((b) => b.booking_id)).toEqual(['bk-1', 'bk-2']);
    expect(app.cancelState).toBe('done');
    expect(app.cancellableCount()).toBe(0);
  });

  test('the cancelled bookings are added to the record, and the permanent records are not undone', async () => {
    const app = await upToApply(component());
    await app.cancelRun();
    expect(app.resultLine()).toContain('12 bookings made, 12 cancelled since');
    // The two permanent classes still read as made, because they still exist.
    expect(app.resultLine()).toContain('6 contacts created (permanent)');
    expect(app.resultLine()).toContain('6 School Passes assigned (permanent)');
  });

  test('a throttle mid-cancel stops it and says so', async () => {
    const app = await upToApply(component({
      unbook: (body, n) => (n <= 8
        ? { status: 200, body: UNBOOK_OK }
        : { status: 429, body: { outcome: 'failed', reason: 'throttled', cancelled: 0 } }),
    }));
    vi.useFakeTimers();
    const cancelling = app.cancelRun();
    await vi.runAllTimersAsync();
    await cancelling;
    vi.useRealTimers();

    expect(app.cancelState).toBe('halted');
    expect(app.cancelMessage).toContain('another system');
    // What did get cancelled is kept, and the rest is still cancellable.
    expect(app.cancellableCount()).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// #111 — a completed run closes the door behind it
// ---------------------------------------------------------------------------
// Found in #74's UAT: after a run finished, walking back to the preview offered
// a live Apply on an unchanged list. The rules are preview.js's; what only the
// page can get wrong is remembering what it ran, and remembering it across the
// two paths a finished run arrives by — the run that just happened, and the one
// restored from this browser's storage.
describe('the already-run gate (#111)', () => {
  test('a finished run blocks a second Apply on the same list', async () => {
    const app = await upToApply(component());
    expect(app.runState).toBe('complete');
    const written = app.__writes.length;

    // Back to the preview, exactly as the operator did it.
    app.go(4);
    expect(app.preview.blockers.some((b) => b.kind === 'already-run')).toBe(true);
    expect(app.preview.ready).toBe(false);

    // And the refusal is real, not just a message beside a live button.
    app.askApply();
    await app.apply();
    expect(app.__writes).toHaveLength(written);
  });

  test('a halted run leaves Apply open — it never reached the whole list', async () => {
    const app = await upToPreview(component({
      // Every student throttled: the engine halts on the first one, so nobody
      // after it was tried.
      student: () => ({ status: 200, body: { ...STUDENT_OK, reason: 'throttled' } }),
    }));
    app.askApply();
    await app.apply();
    expect(app.runState).toBe('halted');

    app.go(4);
    expect(app.preview.blockers.some((b) => b.kind === 'already-run')).toBe(false);
  });

  test('a run that stranded a student leaves Apply open — §12 D5 says re-run', async () => {
    // Finished, but not settled. This is the case a `state === 'complete'`
    // test would have got wrong, and getting it wrong blocks the documented
    // recovery for the one student who actually needs it.
    let n = 0;
    const app = await upToPreview(component({
      // Exactly one, so the breaker never trips and the run reaches its end.
      student: () => {
        n += 1;
        return n === 2
          ? {
            status: 200,
            body: { ...STUDENT_OK, outcome: 'failed', stranded: true, strandedDetail: 'no bookings from this run' },
          }
          : { status: 200, body: STUDENT_OK };
      },
    }));
    app.askApply();
    await app.apply();
    expect(app.runState).toBe('complete');

    app.go(4);
    expect(app.preview.blockers.some((b) => b.kind === 'already-run')).toBe(false);
  });

  test('cancelling the run\u2019s bookings re-opens Apply', async () => {
    // The false positive with no way out: the bookings are gone, re-booking is
    // a thing the operator may now want, and before this the gate still said
    // "already run" with no control anywhere that could clear it.
    const app = await upToApply(component());
    app.go(4);
    expect(app.preview.blockers.some((b) => b.kind === 'already-run')).toBe(true);

    app.go(5);
    app.askCancel();
    await app.cancelRun();
    expect(app.cancelState).toBe('done');

    app.go(4);
    expect(app.preview.blockers.some((b) => b.kind === 'already-run')).toBe(false);
  });

  test('opening a restored run does not conjure a preview onto the screen', async () => {
    // `x-if="preview"` is the whole of what keeps step 5's block off screen.
    // A preview built here renders an empty table and a `nobody-to-book`
    // blocker over the restored run being opened.
    const app = component();
    app.restored = { at: '2026-08-01T00:00:00Z', school: 'newman', sessions: [], state: 'complete', records: [] };
    expect(app.preview).toBeNull();
    app.openRestored();
    expect(app.preview, 'no list has been pasted, so there is nothing to preview').toBeNull();
  });

  test('the gate survives the tab: a restored run still closes Apply', async () => {
    const first = await upToApply(component());
    expect(first.lastRun?.fingerprint, 'the run records its fingerprint').toBeTruthy();
    expect(first.lastRun.settled, 'a clean run is settled').toBe(true);

    // A second visit to the same browser, holding the run the first one left.
    const second = await upToPreview(component({
      restored: {
        at: first.runAt,
        school: 'newman',
        sessions: first.runSessionStarts,
        state: 'complete',
        records: first.runRecords,
        fingerprint: first.lastRun.fingerprint,
        settled: true,
      },
    }));
    second.openRestored();
    second.go(4);
    expect(second.preview.blockers.some((b) => b.kind === 'already-run')).toBe(true);
  });

  test('a stored run from before this field leaves Apply open', async () => {
    // Refusing an import nobody has run is the worse failure of the two: the
    // operator has no way past it and no way to tell why.
    const app = await upToPreview(component({
      restored: { at: '2026-08-01T00:00:00Z', school: 'newman', sessions: [], state: 'complete', records: [] },
    }));
    app.openRestored();
    app.go(4);
    expect(app.preview.blockers.some((b) => b.kind === 'already-run')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The in-progress indicator (#112)
// ---------------------------------------------------------------------------
// UAT of #74 reported the page looking idle mid-run. It was not: the banner
// with the count was on screen the whole time. It was just **above** a table
// growing a row per student, so by student twelve the only thing saying the run
// was alive had scrolled off the top — and in the moments that matter most, a
// 20-second retry backoff or a paced pause, its text does not change either.
//
// The fix is display only, and these tests hold it to that: the run's own
// numbers are untouched, and the indicator clears on all three of the endings
// the engine has, not just the tidy one.

describe('the in-progress indicator (#112)', () => {
  test('mid-run it says where the run has got to', async () => {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const app = await upToPreview(component());
    const original = globalThis.fetch;
    const seen = [];
    globalThis.fetch = vi.fn(async (...args) => {
      seen.push(app.runProgress);
      if (seen.length === 3) await held;
      return original(...args);
    });

    const running = app.apply();
    await Promise.resolve();
    // Held open on the third student: this is the state the operator is
    // looking at while nothing on the wire is moving.
    await vi.waitFor(() => expect(seen).toHaveLength(3));
    expect(app.running).toBe(true);
    expect(app.runState).toBe('running');
    expect(app.runProgress).toBe('2 of 6 students done…');

    release();
    await running;
    globalThis.fetch = original;

    // The line before the first student came back names the size of the run
    // rather than showing `0 of 6`, which reads as stalled at the one moment
    // there is nothing to report yet.
    expect(seen[0]).toBe('Starting 6 students…');
    expect(seen[1]).toBe('1 of 6 students done…');
  });

  test('a completed run clears it', async () => {
    const app = await upToApply(component());
    expect(app.runState).toBe('complete');
    expect(app.runProgress).toBe('');
    expect(app.running).toBe(false);
  });

  test('a halt on the circuit breaker clears it', async () => {
    const app = await upToPreview(component({
      student: () => ({ status: 200, body: { ...STUDENT_OK, ok: false, outcome: 'failed', reason: 'clubworx' } }),
    }));
    await app.apply();
    expect(app.runState).toBe('halted');
    expect(app.runReason).toBe('consecutive-failures');
    expect(app.runProgress).toBe('');
    expect(app.running).toBe(false);
  });

  test('a halt on a throttle clears it', async () => {
    const app = await upToPreview(component({
      student: (body, n) => (n <= 2
        ? { status: 200, body: STUDENT_OK }
        : { status: 429, body: { outcome: 'failed', reason: 'throttled', written: false } }),
    }));
    vi.useFakeTimers();
    const running = app.apply();
    await vi.runAllTimersAsync();
    await running;
    vi.useRealTimers();

    expect(app.runState).toBe('halted');
    expect(app.runReason).toBe('throttled');
    // The quiet 20 seconds of backoff are exactly when the operator most needs
    // to see the run is alive, and exactly when this line does not change. It
    // is the spinner beside it that carries that; this only has to stop.
    expect(app.runProgress).toBe('');
    expect(app.running).toBe(false);
  });

  test('it is display only — the run makes the same calls either way', async () => {
    const app = await upToApply(component());
    expect(app.__writes).toHaveLength(6);
    expect(app.runRecords).toHaveLength(6);
    expect(app.resultLine()).toContain('6 contacts created (permanent)');
  });
});

// The indicator itself is markup, and this repo has no DOM test infrastructure
// and is not gaining any (#78). What the indicator has to be, though, is
// visible and moving — two properties of the page's text, which is what these
// read. The same reasoning as `alpine-bindings.test.js`: where the cheap check
// is also the complete one for the class of fault, it is the right check.
describe('the indicator is on the page, and moves (#112)', () => {
  const banner = (() => {
    const at = html.indexOf(`x-show="runState === 'running'"`);
    expect(at, 'step 6’s running banner is not in the page').toBeGreaterThan(-1);
    const open = html.lastIndexOf('<div', at);
    return html.slice(open, html.indexOf('</div>', at));
  })();

  test('the banner carries a spinner, not only a line of text', () => {
    // The text changes once per student. Between two students — and through a
    // 20-second retry backoff — it is the only thing on screen that has to say
    // "alive", and it says it by not changing.
    expect(banner).toContain('spinner');
  });

  test('the spinner is decoration, and the banner announces itself instead', () => {
    // A spinning ring has nothing to read out. The count beside it does, and
    // `role="status"` is what gets it read without stealing focus mid-run.
    expect(banner).toMatch(/<span[^>]*class="[^"]*spinner[^"]*"[^>]*aria-hidden="true"/);
    // Scoped to the count. On the whole banner, every update re-reads the
    // static sentence beside it — sixty-three times, for a class of 63.
    expect(banner).toMatch(/role="status"[^>]*x-text="runProgress"/);
  });

  test('it stays on screen as the table grows underneath it', () => {
    // The reported fault. The banner was there the whole time; by student
    // twelve it was above the fold of a table adding a row per student.
    expect(banner).toContain('sticky');
  });

  test('the spinner class is actually animated, and not at full speed for everyone', () => {
    const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
    expect(style).toMatch(/@keyframes\s+uj-spin/);
    expect(style).toMatch(/\.spinner\s*\{[^}]*animation:[^}]*uj-spin/);
    // Motion is the point, so it is slowed rather than stopped — a still ring
    // reads as a dead spinner, which is the fault this is fixing, inverted.
    expect(style).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*\.spinner/);
  });
});

describe('a run the tab outlived does not restore as one still going (#112)', () => {
  // The store is written per student (D10), so a tab closed on student 19
  // leaves `state: 'running'` behind. Before #112 that restored as a stale
  // sentence. With a spinner on it, it restores as a page actively claiming a
  // run is in flight, with "Leave this tab open" under a ring that will turn
  // for as long as the tab is open — the exact fault #112 removes, inverted,
  // and on the one path D10 exists for.
  const interrupted = {
    at: '2026-08-22T09:00:00+08:00',
    school: 'newman',
    sessions: [],
    state: 'running',
    records: [
      { key: 1, name: 'Ada Lovelace', state: 'booked', bookings: [], cancel: null },
      { key: 2, name: 'Grace Hopper', state: 'booked', bookings: [], cancel: null },
    ],
  };

  test('it opens as a halt, so nothing on screen says a run is working', async () => {
    const app = await settled(component({ restored: interrupted }));
    app.openRestored();
    expect(app.runState).not.toBe('running');
    expect(app.runState).toBe('halted');
    expect(app.running).toBe(false);
    expect(app.runProgress).toBe('');
  });

  test('it says the tab is why, rather than showing an empty red box', async () => {
    const app = await settled(component({ restored: interrupted }));
    app.openRestored();
    expect(app.runReason).toBe('interrupted');
    expect(app.runMessage).toMatch(/closed|reload/i);
  });

  test('the students that did land are on screen — that is what the record is for', async () => {
    // `x-show="runRecords.length > 0 && runState !== 'running'"` hides the
    // table while a run is going. Restoring as `running` hid the very rows the
    // store was written to preserve.
    const app = await settled(component({ restored: interrupted }));
    app.openRestored();
    expect(app.runRecords).toHaveLength(2);
    expect(app.runRecords.length > 0 && app.runState !== 'running').toBe(true);
  });

  test('a run that did finish is untouched', async () => {
    const app = await settled(component({
      restored: { ...interrupted, state: 'complete' },
    }));
    app.openRestored();
    expect(app.runState).toBe('complete');
    expect(app.runReason).toBe(null);
    expect(app.runMessage).toBe('');
  });
});

// The Clubworx check between steps 4 and 5 is the same shape as the run and
// had the same gap: serial, one student at a time, minutes for a class of 25,
// publishing a preview row per student — so its banner scrolls away under a
// growing table exactly as step 6's did, and its count moves once per student.
// Same treatment, and the same reasoning.
describe('the check between 4 and 5 shows it is working too', () => {
  const banner = (() => {
    const at = html.indexOf(`x-show="checkState === 'running'"`);
    expect(at, 'the check banner is not in the page').toBeGreaterThan(-1);
    const open = html.lastIndexOf('<div', at);
    return html.slice(open, html.indexOf('</div>', at));
  })();

  test('it carries a spinner and stays on screen', () => {
    expect(banner).toContain('spinner');
    expect(banner).toContain('sticky');
  });

  test('the live region is the count, and the spinner is decoration', () => {
    expect(banner).toMatch(/<span[^>]*class="[^"]*spinner[^"]*"[^>]*aria-hidden="true"/);
    expect(banner).toMatch(/role="status"[^>]*x-text="checkProgress"/);
  });

  test('a check that ends clears it — including the plan refusal that ends it early', async () => {
    // `toPreview` has two exits. The early one is §11's hard stop: an
    // unresolved plan stops the check before it spends the allowance on reads
    // for a run that cannot proceed. A spinner left turning on that path is a
    // page that never comes back.
    const app = await upToPreview(component({ plan: { ok: false, reason: 'not-found', error: 'no such plan' } }));
    expect(app.plan.ok).toBe(false);
    expect(app.checkState).toBe('done');
    expect(app.checkProgress).toBe('');
  });

  test('a check that runs to the end clears it', async () => {
    const app = await upToPreview(component());
    expect(app.checkState).toBe('done');
    expect(app.checkProgress).toBe('');
  });
});

// ---------------------------------------------------------------------------
// The cancel says how far it has got too (#112)
// ---------------------------------------------------------------------------
// D12's cancel is the same paced, one-call-per-student loop as Apply, and it
// had less to show for it than either of the others: no count at all, just
// "Cancelling, one student at a time…". A whole-run cancel is up to 150 DELETEs
// plus a verifying re-read per student, so it is minutes of a page saying
// nothing while it deletes things.
//
// Its denominator is the awkward part. The loop SKIPS a record with nothing
// this run booked, so it is neither the row count nor the booking count the
// control above it quotes.

describe('the cancel reports its progress (#112)', () => {
  test('it counts the students it will actually call for, not the rows', async () => {
    const app = await upToApply(component());
    // Six students, two bookings each: the control offers 12 bookings, the
    // loop makes 6 calls. The progress is in the loop's unit and says so.
    expect(app.cancellableCount()).toBe(12);

    const seen = [];
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async (...args) => {
      seen.push(app.cancelProgress);
      return original(...args);
    });
    app.askCancel();
    await app.cancelRun();
    globalThis.fetch = original;

    expect(seen[0]).toBe('Starting 6 students…');
    expect(seen[1]).toBe('1 of 6 students done…');
    expect(seen).toHaveLength(6);
  });

  test('a row this run did not book is not in the denominator', async () => {
    // D12's interlock: an `already booked` row is never sent, so counting it
    // would leave the progress permanently short of its own total.
    const app = await upToApply(component({
      student: (body, n) => (n <= 2
        ? { status: 200, body: { ...STUDENT_OK, outcome: 'already-booked', bookings: [] } }
        : { status: 200, body: STUDENT_OK }),
    }));
    const seen = [];
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async (...args) => { seen.push(app.cancelProgress); return original(...args); });
    app.askCancel();
    await app.cancelRun();
    globalThis.fetch = original;

    expect(seen[0]).toBe('Starting 4 students…');
    expect(seen).toHaveLength(4);
  });

  test('a completed cancel clears it', async () => {
    const app = await upToApply(component());
    app.askCancel();
    await app.cancelRun();
    expect(app.cancelState).toBe('done');
    expect(app.cancelProgress).toBe('');
    expect(app.running).toBe(false);
  });

  test('a throttled cancel clears it too', async () => {
    const app = await upToApply(component({
      unbook: (body, n) => (n <= 1
        ? { status: 200, body: UNBOOK_OK }
        : { status: 429, body: { ok: false, outcome: 'failed', reason: 'throttled', cancelled: 0, cancelledIds: [] } }),
    }));
    vi.useFakeTimers();
    app.askCancel();
    const cancelling = app.cancelRun();
    await vi.runAllTimersAsync();
    await cancelling;
    vi.useRealTimers();

    expect(app.cancelState).toBe('halted');
    expect(app.cancelProgress).toBe('');
    expect(app.running).toBe(false);
  });

  test('the line is on the page, with a spinner beside it', () => {
    const at = html.indexOf(`x-show="cancelState === 'running'"`);
    expect(at, 'the cancel’s running line is not in the page').toBeGreaterThan(-1);
    const open = html.lastIndexOf('<div', at);
    const line = html.slice(open, html.indexOf('</div>', at));
    expect(line).toContain('spinner');
    expect(line).toMatch(/role="status"[^>]*x-text="cancelProgress"/);
  });
});

// ---------------------------------------------------------------------------
// The result step confirms, and the reset starts the next school (#113)
// ---------------------------------------------------------------------------
// UAT of #74: the most prominent control on a finished run was "Cancel bookings
// from this run", with no comparably prominent confirmation that the import had
// worked and no way to move on to the next school. Two things this must not get
// wrong — a confirmation over a run that did not work, and a reset that takes
// the operator's only record of permanent writes away with it.
describe('the result step’s confirmation and reset (#113)', () => {
  test('a clean run is confirmed, and the confirmation names the students', async () => {
    const app = await upToApply(component());
    expect(app.runState).toBe('complete');
    expect(app.successLine()).toContain('6 students');
  });

  test('a halted run is not confirmed — the banner reads from the outcome, not the ending', async () => {
    const app = await upToPreview(component({
      student: () => ({ status: 200, body: { ...STUDENT_OK, reason: 'throttled' } }),
    }));
    app.askApply();
    await app.apply();
    expect(app.runState).toBe('halted');
    expect(app.successLine()).toBe('');
  });

  test('the reset clears the school, the list, the resolutions, the sessions and the table', async () => {
    const app = await upToApply(component());
    expect(app.stepIndex).toBe(5);

    app.askReset();
    expect(app.resetConfirming).toBe(true);
    app.startAnotherImport();

    expect(app.resetConfirming).toBe(false);
    expect(app.tag).toBe('');
    expect(app.rawPaste).toBe('');
    expect(app.countValue).toBe('');
    expect(app.declaredFor).toBeNull();
    expect(app.parsed).toBeNull();
    expect(app.reviewed).toBeNull();
    expect(app.resolutions).toEqual({});
    expect(app.picked).toEqual([]);
    expect(app.selection.ready).toBe(false);
    expect(app.matches).toEqual({});
    expect(app.checkState).toBe('idle');
    expect(app.preview).toBeNull();
    expect(app.runRecords).toEqual([]);
    expect(app.runState).toBe('idle');
    // Back to the first step, and the strip goes with it: a step the operator
    // can click forward into is a step holding the last school's answers.
    expect(app.stepIndex).toBe(0);
    expect(app.maxStepReached).toBe(0);
  });

  test('the reset keeps the record — the run is offered back, not destroyed', async () => {
    // Contacts and School Passes cannot be deleted, so the stored run is the
    // only record that they were made (D10). Clearing the screen must not be
    // the thing that loses it.
    const app = await upToApply(component());
    app.startAnotherImport();
    expect(app.restored, 'the finished run is offered again').toBeTruthy();
    expect(app.restored.records).toHaveLength(6);
    expect(app.__stored.get('uj-school-booking-run')).toBeTruthy();
  });

  test('the reset is not a way back into an import that has already run', async () => {
    // #111's gate is what stops a second Apply on an unchanged list. The reset
    // is the way to start a *different* import, not the way to re-enable Apply
    // on a finished one, so what this browser has already run survives it.
    const app = await upToApply(component());
    app.startAnotherImport();
    await upToPreview(app);
    expect(app.preview.blockers.some((b) => b.kind === 'already-run')).toBe(true);
  });

  test('nothing resets mid-run', async () => {
    // The engine is writing into `runRecords` from a loop this cannot stop.
    const app = await upToApply(component());
    app.running = true;
    app.askReset();
    expect(app.resetConfirming).toBe(false);
    app.startAnotherImport();
    expect(app.runRecords).toHaveLength(6);
    expect(app.stepIndex).toBe(5);

    app.running = false;
    app.cancelState = 'running';
    app.startAnotherImport();
    expect(app.runRecords).toHaveLength(6);
  });

  test('the two confirms on this step are never open together', async () => {
    // "Cancel 12 bookings?" and "Clear this and start another school?" on one
    // screen, each with its own Yes, is a question the operator cannot answer.
    const app = await upToApply(component());
    app.askCancel();
    expect(app.cancelConfirming).toBe(true);
    app.askReset();
    expect(app.cancelConfirming).toBe(false);
    expect(app.resetConfirming).toBe(true);
    app.askCancel();
    expect(app.resetConfirming).toBe(false);
    expect(app.cancelConfirming).toBe(true);
  });

  test('standing the reset down leaves everything where it was', async () => {
    const app = await upToApply(component());
    app.askReset();
    app.standDownReset();
    expect(app.resetConfirming).toBe(false);
    expect(app.runRecords).toHaveLength(6);
  });

  test('step 1 offers the reset only when there is something to clear', async () => {
    const app = component();
    await settled(app);
    expect(app.holdingAnImport()).toBe(false);
    app.tag = 'newman';
    expect(app.holdingAnImport()).toBe(true);
    app.startAnotherImport();
    expect(app.holdingAnImport()).toBe(false);
  });
});

// The banner and the two reset controls are markup, and this repo has no DOM
// test infrastructure and is not gaining any (#78). What they have to be is
// bound to the rules rather than to a literal — a property of the page's text,
// which is what these read. Same reasoning as `alpine-bindings.test.js`.
describe('the confirmation and the reset are on the page, and bound (#113)', () => {
  const summary = (() => {
    const at = html.indexOf('x-text="resultLine()"');
    expect(at, 'the result summary is not in the page').toBeGreaterThan(-1);
    const open = html.lastIndexOf('<div class="rounded-xl', at);
    return html.slice(open, html.indexOf('</section>', at));
  })();

  test('the confirmation’s words and its tone both come from successLine()', () => {
    // A green panel with a literal "Import complete" in it would be a banner
    // the outcome rules cannot switch off — the one failure mode this feature
    // has. Both the text and the colour are asked for.
    expect(summary).toContain('x-text="successLine()"');
    expect(summary).toMatch(/:class="successLine\(\)[\s\S]*emerald[\s\S]*amber/);
  });

  test('D11’s summary is still shown either way', () => {
    // The confirmation leads; it does not replace. The sentence the preview
    // showed, in past tense, is the only way to check that what happened is
    // what was agreed to.
    expect(summary).toContain('x-text="resultLine()"');
    expect(summary).toContain('x-text="strandedWarning()"');
  });

  test('the result step offers the reset, behind its confirm', () => {
    expect(summary).toContain('@click="askReset()"');
    expect(summary).toContain('@click="startAnotherImport()"');
    expect(summary).toContain('@click="standDownReset()"');
  });

  test('step 1 carries the same control, and only when there is something to clear', () => {
    const step = html.slice(html.indexOf('Which school is this?'), html.indexOf('x-text="schoolsNote()"'));
    expect(step).toContain('x-show="holdingAnImport()"');
    expect(step).toContain('@click="askReset()"');
    expect(step).toContain('@click="startAnotherImport()"');
  });

  test('the cancel control is demoted and nothing else — #113 must not weaken it', () => {
    // The only reversible thing this tool does. Its label is still the count
    // the interlock allows, its confirm is still in front of it, and the
    // permanence sentence is still beside it rather than in a footnote.
    const panel = html.slice(html.indexOf('>Taking it back<'), html.indexOf('Back to the preview'));
    expect(panel).toContain('@click="askCancel()"');
    expect(panel).toContain('@click="cancelRun()"');
    expect(panel).toContain('@click="standDownCancel()"');
    expect(panel).toMatch(/x-text="`Cancel \$\{cancellableCount\(\)\}/);
    expect(panel).toContain('the API has no delete for either');
    // Still visible without opening anything: demoted is not hidden.
    expect(panel).not.toMatch(/<details|x-show="showCancel/);
  });
});

// The reset restates ~45 of the component literal's initial values, and nothing
// in the language links the two copies. The risk is not today's code — it is a
// field added to the literal in six months and not added here, which leaves one
// school's answer on the page for the next school's import with no symptom
// until it matters. This is the link: a reset page must be a fresh page.
describe('the reset leaves nothing of the last import behind (#113)', () => {
  test('every field matches a page that has never had an import on it', async () => {
    const fresh = component();
    await settled(fresh);

    const app = await upToApply(component());
    app.startAnotherImport();

    // The three it keeps on purpose, each for a reason in the method's header:
    // the record of permanent writes, what this browser has already run, and a
    // read of Clubworx that is not an answer of the operator's.
    const kept = new Set(['restored', 'lastRun', 'schools', 'schoolsState']);
    // Re-seeded by `openDatePicker` on every open, from the date boxes or from
    // today — never carried across an import, whatever they hold now.
    const seeded = new Set(['dpYear', 'dpMonth']);

    for (const key of Object.keys(fresh)) {
      if (key.startsWith('__') || typeof fresh[key] === 'function') continue;
      if (kept.has(key) || seeded.has(key)) continue;
      expect(app[key], `\`${key}\` survived the reset — add it to startAnotherImport()`)
        .toEqual(fresh[key]);
    }

    // And the keepers are actually kept, so the exemption list cannot quietly
    // become the way a field escapes the check above.
    expect(app.restored, 'the stored run is offered back').toBeTruthy();
    expect(app.lastRun?.fingerprint, '#111 still knows what this browser ran').toBeTruthy();
    expect(app.schools).toEqual(fresh.schools);
  });
});

// ---------------------------------------------------------------------------
// #146 — the reminder that outlives the run
// ---------------------------------------------------------------------------
// The lasting damage this feature can do is not a failed booking — that is loud
// and self-correcting. It is a Clubworx restriction left off: a class open to
// public booking for as long as nobody notices. So the reminder is sourced from
// the *selection*, and the two tests that matter most below are the halted run
// and the reload.

describe('the restrictions left lifted are named after the run (#146)', () => {
  const SOON_LABEL = 'School Session — Newman, 2026-08-22';

  const ranWithOverride = async (opts = {}) => {
    const app = await withSoon(opts);
    app.askLeadTimeOverride('e0');
    app.confirmLeadTimeOverride();
    await app.toPreview();
    app.askApply();
    await app.apply();
    return app;
  };

  test('a finished run still names the session whose restriction was lifted', async () => {
    // A clean run is exactly the case an operator would call finished and walk
    // away from — and it left the restriction off just the same.
    const app = await ranWithOverride();
    expect(app.runState).toBe('complete');

    const reminder = app.liftedRestrictionsReminder();
    expect(reminder).toContain(SOON_LABEL);
    expect(reminder).toMatch(/restriction/i);
    expect(reminder).toMatch(/put it back/i);
  });

  test('a run that halted before reaching the session still names it', async () => {
    // The criterion this ticket turns on. Three refusals in a row halt the run
    // (D7), so there is no result row for the acknowledged session at all — and
    // a reminder read off the results would vanish here, on the run most likely
    // to have left a restriction open.
    const app = await ranWithOverride({
      student: () => ({
        status: 200,
        body: { outcome: 'refused', reason: 'lead-time', written: false, message: 'too soon' },
      }),
    });

    expect(app.runState).toBe('halted');
    expect(app.runRecords.some((r) => r.state === 'booked')).toBe(false);
    expect(app.liftedRestrictionsReminder()).toContain(SOON_LABEL);
  });

  test('a run nobody overrode shows no reminder', async () => {
    const app = await upToApply(component());
    expect(app.runRecords).toHaveLength(6);
    expect(app.liftedRestrictionsReminder()).toBe('');
  });

  test('the summary and the stranded warning are untouched beside it', async () => {
    // Both surfaces say "a human has something left to do in Clubworx", and
    // both have to be able to say it at once.
    const app = await ranWithOverride({
      student: (body, n) => (n === 1
        ? {
          status: 200,
          body: {
            outcome: 'abandoned',
            reason: 'booking-refused',
            written: true,
            contact: { contact_key: 'c-new', state: 'created' },
            pass: { state: 'created-with-contact' },
            bookings: [],
            stranded: true,
            strandedDetail: 'contact and pass, no bookings',
            message: 'refused',
          },
        }
        : { status: 200, body: STUDENT_OK }),
    });

    expect(app.strandedWarning()).toContain('contact and a pass but no bookings');
    expect(app.resultLine()).toContain('created (permanent)');
    expect(app.liftedRestrictionsReminder()).toContain(SOON_LABEL);
  });

  test('the record staff copy out carries it too', async () => {
    const app = await ranWithOverride();
    const parsed = JSON.parse(app.recordText());
    expect(parsed.lifted).toContain(SOON_LABEL);
    // D10's record is otherwise what it was.
    expect(parsed.students).toHaveLength(6);
    expect(parsed.school).toBe('newman');
  });

  test('it survives the tab: a restored run still names the lifted session', async () => {
    const first = await ranWithOverride();
    expect(first.__stored.get('uj-school-booking-run')).toBeTruthy();

    const second = await upToPreview(component({
      restored: JSON.parse(first.__stored.get('uj-school-booking-run')),
    }));
    second.openRestored();
    expect(second.liftedRestrictionsReminder()).toContain(SOON_LABEL);
    expect(JSON.parse(second.recordText()).lifted).toContain(SOON_LABEL);
  });

  test('a stored run from before this field says nothing rather than guessing', async () => {
    const app = await upToPreview(component({
      restored: {
        at: '2026-08-24T10:00:00+08:00', school: 'newman', sessions: [], state: 'complete', records: [],
      },
    }));
    app.openRestored();
    expect(app.liftedRestrictionsReminder()).toBe('');
  });

  test('nothing about the reminder is gated on the run having results', async () => {
    // The value is sourced from the selection; this pins the *rendering* to the
    // same rule. `resultLine()` is empty over no records, and it is what the
    // summary banner is shown on — so a reminder rendered inside that banner
    // would be behind the run's results after all the care taken to keep it
    // out of them. Both halves are asserted: the state, and the markup that
    // reads it.
    const app = await ranWithOverride();
    app.runRecords = [];
    expect(app.resultLine()).toBe('');
    expect(app.liftedRestrictionsReminder()).toContain(SOON_LABEL);

    // The reminder's own block, and its only condition is itself.
    const at = html.indexOf('x-show="liftedRestrictionsReminder()"');
    expect(at, 'the reminder is rendered on the result surface').toBeGreaterThan(-1);
    // The reset control is the last thing inside that banner, so a reminder
    // after it is a reminder outside it.
    // `lastIndexOf` — step 1 renders the same control, and it is the step 6
    // copy that closes this banner.
    const lastInBanner = html.lastIndexOf('@click="startAnotherImport()"');
    expect(lastInBanner).toBeGreaterThan(html.indexOf('x-show="resultLine()"'));
    expect(at, 'the reminder sits outside the resultLine() banner').toBeGreaterThan(lastInBanner);
  });

  test('starting another import clears it', async () => {
    const app = await ranWithOverride();
    expect(app.liftedRestrictionsReminder()).toContain(SOON_LABEL);
    app.askReset();
    app.startAnotherImport();
    expect(app.liftedRestrictionsReminder()).toBe('');
  });
});
