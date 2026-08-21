// Step 4's rules, exercised without a network or a clock.
//
// staff-site#72. The Worker (#67) decides what an event *is* — its lead time,
// whether it is bookable — and this module decides what a **selection** is:
// which events arrive pre-ticked, what a pasted id resolves to, and what stops
// the run. Those are two different questions and only the second one has to
// survive `GET /events/:id` not being a route (#97).

import { describe, expect, test } from 'vitest';
import {
  defaultWindow,
  preTicked,
  resolvePastedId,
  selectedEvents,
  selectionReport,
  sessionsLine,
} from '../events.js';

// A projected event, in the shape `cloudflare-clubworx/src/events.js` emits.
const event = (over = {}) => ({
  event_id: '1',
  event_name: 'School Session — Newman',
  event_start_at: '2026-09-01T09:00:00+08:00',
  event_end_at: '2026-09-01T10:30:00+08:00',
  location_id: 'loc-1',
  location_name: 'Urban Jungle',
  free_class: false,
  event_full: false,
  spaces_available: 30,
  lead: { hoursAhead: 240, past: false, withinLeadTime: false, minLeadHours: 24, unreadable: false },
  bookable: true,
  ...over,
});

describe('defaultWindow', () => {
  test('it opens on the run day and runs a term ahead', () => {
    expect(defaultWindow('2026-08-21T14:00:00+08:00')).toEqual({
      from: '2026-08-21',
      to: '2026-11-19',
    });
  });

  test('it reads the day in Perth, not in UTC', () => {
    // 07:30 on the 22nd in Perth is 23:30 on the 21st in UTC. A window opening
    // on the UTC day would leave this morning's sessions out of the picker for
    // the eight hours that matter most.
    expect(defaultWindow('2026-08-21T23:30:00Z').from).toBe('2026-08-22');
  });

  test('an unreadable instant gets no window rather than a wrong one', () => {
    expect(defaultWindow('not a date')).toEqual({ from: '', to: '' });
  });
});

describe('preTicked', () => {
  const series = [
    event({ event_id: 'a', event_start_at: '2026-09-01T09:00:00+08:00' }),
    event({ event_id: 'b', event_start_at: '2026-09-08T09:00:00+08:00' }),
    event({ event_id: 'c', event_start_at: '2026-09-15T09:00:00+08:00' }),
  ];

  test('the anchor and every same-name, same-location session ahead of it', () => {
    expect(preTicked(series, 'a')).toEqual(['a', 'b', 'c']);
  });

  test('sessions before the anchor are left alone', () => {
    // Staff pick the *first* session. Ticking last term's leftovers behind it
    // would book a group into a class that has already happened.
    expect(preTicked(series, 'b')).toEqual(['b', 'c']);
  });

  test('a different name is a different series', () => {
    const mixed = [...series, event({ event_id: 'd', event_name: 'Open Climb', event_start_at: '2026-09-08T09:00:00+08:00' })];
    expect(preTicked(mixed, 'a')).toEqual(['a', 'b', 'c']);
  });

  test('a different location is a different series', () => {
    const mixed = [...series, event({ event_id: 'e', location_id: 'loc-2', event_start_at: '2026-09-08T09:00:00+08:00' })];
    expect(preTicked(mixed, 'a')).toEqual(['a', 'b', 'c']);
  });

  test('names are compared on their trimmed, case-folded form', () => {
    const mixed = [
      event({ event_id: 'a' }),
      event({ event_id: 'f', event_name: '  school session — newman ', event_start_at: '2026-09-08T09:00:00+08:00' }),
    ];
    expect(preTicked(mixed, 'a')).toEqual(['a', 'f']);
  });

  test('an unbookable session ahead is still pre-ticked, so its reason is on screen', () => {
    // §8 annotates rather than filters, and D9 refuses to drop a session
    // silently. A too-soon session that arrives unticked looks like a session
    // that is not part of the series.
    const soon = event({
      event_id: 'g',
      event_start_at: '2026-09-08T09:00:00+08:00',
      bookable: false,
      lead: { hoursAhead: 4, past: false, withinLeadTime: true, minLeadHours: 24, unreadable: false },
    });
    expect(preTicked([event({ event_id: 'a' }), soon], 'a')).toEqual(['a', 'g']);
  });

  test('an anchor that is not in the list ticks nothing', () => {
    expect(preTicked(series, 'zzz')).toEqual([]);
    expect(preTicked(series, null)).toEqual([]);
  });

  test('an event with no name only matches its own id', () => {
    // Two nameless events are not evidence of a series. Grouping them would
    // pre-tick an unrelated class on the strength of a field nobody filled in.
    const nameless = [
      event({ event_id: 'a', event_name: null }),
      event({ event_id: 'b', event_name: null, event_start_at: '2026-09-08T09:00:00+08:00' }),
    ];
    expect(preTicked(nameless, 'a')).toEqual(['a']);
  });
});

describe('resolvePastedId', () => {
  const window = [event({ event_id: 'a' }), event({ event_id: 'b', event_start_at: '2026-09-08T09:00:00+08:00' })];

  test('an id in the loaded window resolves to its event', () => {
    const found = resolvePastedId(window, 'b');
    expect(found.ok).toBe(true);
    expect(found.event.event_id).toBe('b');
  });

  test('surrounding whitespace is forgiven; a pasted id often carries it', () => {
    expect(resolvePastedId(window, '  a \n').ok).toBe(true);
  });

  test('ids are compared as strings, so a numeric id pastes as text', () => {
    const numeric = [event({ event_id: 4321 })];
    expect(resolvePastedId(numeric, '4321').ok).toBe(true);
  });

  test('an empty paste is a refusal, not a miss', () => {
    const answer = resolvePastedId(window, '   ');
    expect(answer).toMatchObject({ ok: false, reason: 'no-id' });
  });

  test('an id outside the loaded window says so, and never says "not found"', () => {
    // #97 measured that `GET /events/:id` answers 404 for every id, real or
    // invented, so the Worker cannot tell these apart and neither can this.
    // Reporting "no such event" would send staff to fix a correct id.
    const answer = resolvePastedId(window, '9999');
    expect(answer.ok).toBe(false);
    expect(answer.reason).toBe('not-in-window');
    expect(answer.message).toMatch(/window/i);
    expect(answer.message).not.toMatch(/not found|no such/i);
  });

  test('an empty window is reported as an unloaded picker, not as a miss', () => {
    expect(resolvePastedId([], 'a')).toMatchObject({ ok: false, reason: 'no-events' });
  });
});

describe('selectedEvents', () => {
  test('selected events come back in timetable order, whatever order they were ticked', () => {
    const list = [
      event({ event_id: 'a', event_start_at: '2026-09-15T09:00:00+08:00' }),
      event({ event_id: 'b', event_start_at: '2026-09-01T09:00:00+08:00' }),
    ];
    expect(selectedEvents(list, ['a', 'b']).map((e) => e.event_id)).toEqual(['b', 'a']);
  });

  test('a selected id with no event behind it is dropped rather than faked', () => {
    expect(selectedEvents([event({ event_id: 'a' })], ['a', 'ghost'])).toHaveLength(1);
  });
});

describe('selectionReport', () => {
  const ok = event({ event_id: 'a' });
  const later = event({ event_id: 'b', event_start_at: '2026-09-08T09:00:00+08:00' });

  test('nothing selected is a hard-stop', () => {
    const report = selectionReport({ events: [ok], selected: [], studentCount: 6 });
    expect(report.ready).toBe(false);
    expect(report.blockers.map((b) => b.kind)).toContain('no-events');
  });

  test('a workable selection is ready and carries its dates', () => {
    const report = selectionReport({ events: [ok, later], selected: ['a', 'b'], studentCount: 6 });
    expect(report.ready).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(report.firstSession).toBe('2026-09-01');
    expect(report.lastSession).toBe('2026-09-08');
    expect(report.bookings).toBe(12);
  });

  test('a session inside the lead time is a hard-stop naming that session', () => {
    const soon = event({
      event_id: 'c',
      event_start_at: '2026-08-21T18:00:00+08:00',
      bookable: false,
      lead: { hoursAhead: 4, past: false, withinLeadTime: true, minLeadHours: 24, unreadable: false },
    });
    const report = selectionReport({ events: [ok, soon], selected: ['a', 'c'], studentCount: 6 });
    expect(report.ready).toBe(false);

    const blocker = report.blockers.find((b) => b.kind === 'lead-time');
    expect(blocker.severity).toBe('block');
    // D9: the fix is offered, never taken. A session dropped on the page's own
    // initiative is the silent adjustment the whole design refuses.
    expect(blocker.actions).toEqual([
      { key: 'remove:c', label: 'Remove this session', answers: 'remove', value: 'c' },
    ]);
    expect(blocker.detail).toMatch(/24 hours/);
  });

  test('every too-soon session gets its own removal, not one blocker for the set', () => {
    const soon = (id, at) => event({
      event_id: id,
      event_start_at: at,
      bookable: false,
      lead: { hoursAhead: 4, past: false, withinLeadTime: true, minLeadHours: 24, unreadable: false },
    });
    const report = selectionReport({
      events: [soon('c', '2026-08-21T18:00:00+08:00'), soon('d', '2026-08-21T19:00:00+08:00')],
      selected: ['c', 'd'],
      studentCount: 6,
    });
    expect(report.blockers.filter((b) => b.kind === 'lead-time')).toHaveLength(2);
  });

  test('a session that has already started blocks on its own reason', () => {
    const past = event({
      event_id: 'e',
      event_start_at: '2026-08-01T09:00:00+08:00',
      bookable: false,
      lead: { hoursAhead: -480, past: true, withinLeadTime: false, minLeadHours: 24, unreadable: false },
    });
    const report = selectionReport({ events: [past], selected: ['e'], studentCount: 6 });
    const blocker = report.blockers.find((b) => b.kind === 'past-session');
    expect(blocker.severity).toBe('block');
    expect(blocker.actions[0].answers).toBe('remove');
  });

  test('an unreadable start time blocks rather than being assumed bookable', () => {
    const broken = event({
      event_id: 'f',
      event_start_at: 'whenever',
      bookable: false,
      lead: { hoursAhead: null, past: null, withinLeadTime: null, minLeadHours: 24, unreadable: true },
    });
    const report = selectionReport({ events: [broken], selected: ['f'], studentCount: 6 });
    expect(report.blockers.map((b) => b.kind)).toContain('unreadable-session');
    expect(report.ready).toBe(false);
  });

  test('too few spaces warns and never blocks', () => {
    // #50: this number has been wrong in both directions, so it is worth
    // saying and not worth obeying.
    const tight = event({ event_id: 'g', spaces_available: 4 });
    const report = selectionReport({ events: [tight], selected: ['g'], studentCount: 25 });
    const warning = report.blockers.find((b) => b.kind === 'spaces');
    expect(warning.severity).toBe('warn');
    expect(warning.detail).toMatch(/4/);
    expect(report.ready).toBe(true);
  });

  test('a null spaces count is not read as zero', () => {
    const unknown = event({ event_id: 'h', spaces_available: null });
    const report = selectionReport({ events: [unknown], selected: ['h'], studentCount: 25 });
    expect(report.blockers.some((b) => b.kind === 'spaces')).toBe(false);
  });

  test('no students is a hard-stop even with sessions picked', () => {
    const report = selectionReport({ events: [ok], selected: ['a'], studentCount: 0 });
    expect(report.blockers.map((b) => b.kind)).toContain('no-students');
    expect(report.ready).toBe(false);
  });

  test('a truncated listing warns, because the session wanted may be off the end', () => {
    const report = selectionReport({ events: [ok], selected: ['a'], studentCount: 6, truncated: true });
    const warning = report.blockers.find((b) => b.kind === 'truncated');
    expect(warning.severity).toBe('warn');
    expect(report.ready).toBe(true);
  });
});

describe('sessionsLine', () => {
  test('it counts sessions, students and the bookings they multiply out to', () => {
    const line = sessionsLine({ sessions: 6, students: 4, bookings: 24 });
    expect(line).toBe('6 sessions × 4 students = 24 bookings.');
  });

  test('it stays grammatical at one of each', () => {
    expect(sessionsLine({ sessions: 1, students: 1, bookings: 1 })).toBe(
      '1 session × 1 student = 1 booking.',
    );
  });

  test('nothing picked yet says nothing', () => {
    expect(sessionsLine({ sessions: 0, students: 4, bookings: 0 })).toBe('');
  });
});
