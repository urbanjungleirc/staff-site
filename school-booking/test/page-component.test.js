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

function component({ schools = SCHOOLS, schoolsFail = false } = {}) {
  globalThis.window = { schoolListParser: parser, schoolBookingSteps: steps };
  globalThis.fetch = vi.fn(async (url) => {
    if (String(url).includes('/api/clubworx/schools')) {
      if (schoolsFail) return { ok: false, status: 502, json: async () => ({ error: 'upstream' }) };
      return { ok: true, status: 200, json: async () => ({ ok: true, schools }) };
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
  test('it loads the schools and the signed-in identity', async () => {
    const app = await settled(component());
    expect(app.bootstrapError).toBe('');
    expect(app.schools).toHaveLength(2);
    expect(app.accessEmail).toBe('staff@urbanjungleirc.com');
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
    globalThis.window = { schoolBookingSteps: steps };
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

  test('a mismatch blocks, and offers no re-declare until staff move it', async () => {
    const app = await upToStepThree(component(), { count: '21' });
    expect(app.reviewed.ready).toBe(false);
    expect(app.canRedeclare()).toBe(false);

    app.dismissRow(2); // the first student
    expect(app.reviewed.counts.records).toBe(5);
    expect(app.canRedeclare()).toBe(true);

    app.redeclare();
    expect(app.countValue).toBe('5');
    expect(app.reviewed.ready).toBe(true);
  });

  test('the drawer and the sums say the same thing as the module', async () => {
    const app = await upToStepThree(component(), { text: VERTICAL, count: '5' });
    expect(app.ignoredSummary()).toBe('7 lines ignored before the first student');
    expect(app.ignoredColumnsLine()).toBe('3 columns ignored: FormGroup, YearLevel, Email.');
    expect(app.reconciliationLine()).toBe('5 students + 7 ignored + 0 unreadable = 37 lines pasted.');
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

  test('a block size that cannot describe a list is not sent at all', async () => {
    const app = await upToStepThree(component(), { text: VERTICAL, count: '5' });
    app.setBlockSize('1');
    app.setBlockSize('not a number');
    expect(app.reviewed.blockSize).toBe(6);
    expect(app.reviewed.blockers.some((b) => b.kind === 'refusal')).toBe(false);
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

  test('the row helpers describe every row without throwing', async () => {
    const app = await upToStepThree(component(), { text: WITH_STRAY_LINE, count: '2' });
    for (const row of app.reviewed.rows) {
      expect(typeof app.nameOf(row)).toBe('string');
      expect(app.laneFor(row)).toMatch(/^lane-/);
      expect(typeof app.stateTone(row)).toBe('string');
    }
  });
});
