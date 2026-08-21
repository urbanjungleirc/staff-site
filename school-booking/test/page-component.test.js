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

// The four routes steps 1–5 read, all of them GETs. Nothing on this page has a
// write path yet — Apply is #73 — so a component test that ever sees a POST is
// a test that has caught the page doing something it must not.
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

function component({
  schools = SCHOOLS,
  schoolsFail = false,
  eventList = EVENTS,
  eventsFail = false,
  plan = PLAN,
  candidatesFor = () => [],
  contactsFail = false,
} = {}) {
  globalThis.window = {
    schoolListParser: parser,
    schoolBookingSteps: steps,
    schoolBookingIdentity: identity,
    schoolBookingEvents: events,
    schoolBookingPreview: preview,
    schoolBookingCalendar: calendar,
  };
  globalThis.fetch = vi.fn(async (url) => {
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
    return { ok: true, status: 200, json: async () => ({ email: 'staff@urbanjungleirc.com' }) };
  });
  return makeComponent();
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
