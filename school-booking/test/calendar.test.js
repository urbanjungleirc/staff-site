// The month grid behind the house date picker, without a DOM.
//
// staff-site#106. roster.html draws the same calendar imperatively; this is the
// same shape as data, so the school booking page can render it with Alpine and
// the arithmetic can be tested rather than eyeballed in a dropdown.

import { describe, expect, test } from 'vitest';
import { isRealDay, monthGrid, monthLabel, monthOf, shiftMonth, todayInPerth } from '../calendar.js';

const days = (grid) => grid.filter((cell) => !cell.empty);

describe('isRealDay', () => {
  test('a real day passes', () => {
    expect(isRealDay('2026-08-21')).toBe(true);
    expect(isRealDay('2024-02-29')).toBe(true); // a leap year
  });

  test('a day that does not exist is refused rather than rolled forward', () => {
    // The one worth naming: `new Date('2026-02-30')` does not throw, it rolls
    // to 2 March. A window silently shifted by two days is a session missing
    // from the picker with nothing on screen to explain it.
    expect(isRealDay('2026-02-30')).toBe(false);
    expect(isRealDay('2026-13-01')).toBe(false);
    expect(isRealDay('2025-02-29')).toBe(false); // not a leap year
  });

  test('anything that is not a YYYY-MM-DD day is refused', () => {
    expect(isRealDay('')).toBe(false);
    expect(isRealDay(null)).toBe(false);
    expect(isRealDay('21/08/2026')).toBe(false);
    expect(isRealDay('2026-8-21')).toBe(false);
    expect(isRealDay('2026-08-21T09:00:00Z')).toBe(false);
  });
});

describe('monthOf', () => {
  test('it reads the month a day belongs to, counting months from zero', () => {
    // Zero-based to match `Date.prototype.getMonth`, which is what roster.html
    // uses — one calendar counting from 0 and another from 1 on the same site
    // is an off-by-one waiting for whoever copies between them.
    expect(monthOf('2026-08-21')).toEqual({ year: 2026, month: 7 });
  });

  test('a day it cannot read gets null, not a guess', () => {
    expect(monthOf('nonsense')).toBe(null);
    expect(monthOf('2026-02-30')).toBe(null);
  });
});

describe('shiftMonth', () => {
  test('it walks forward and back', () => {
    expect(shiftMonth(2026, 7, 1)).toEqual({ year: 2026, month: 8 });
    expect(shiftMonth(2026, 7, -1)).toEqual({ year: 2026, month: 6 });
  });

  test('it rolls the year at both ends', () => {
    expect(shiftMonth(2026, 11, 1)).toEqual({ year: 2027, month: 0 });
    expect(shiftMonth(2026, 0, -1)).toEqual({ year: 2025, month: 11 });
  });
});

describe('monthLabel', () => {
  test('it names the month and year', () => {
    expect(monthLabel(2026, 7)).toBe('August 2026');
    expect(monthLabel(2027, 0)).toBe('January 2027');
  });
});

describe('monthGrid', () => {
  test('it starts on Monday, so the leading blanks match the house calendar', () => {
    // 1 August 2026 is a Saturday, so Mon–Fri lead in as blanks.
    const grid = monthGrid(2026, 7, {});
    expect(grid.slice(0, 5).every((cell) => cell.empty)).toBe(true);
    expect(grid[5]).toMatchObject({ day: 1, iso: '2026-08-01' });
  });

  test('a month starting on a Monday has no leading blanks', () => {
    // 1 June 2026 is a Monday.
    expect(monthGrid(2026, 5, {})[0]).toMatchObject({ day: 1, iso: '2026-06-01' });
  });

  test('it holds every day of the month, and no more', () => {
    expect(days(monthGrid(2026, 7, {}))).toHaveLength(31); // August
    expect(days(monthGrid(2026, 8, {}))).toHaveLength(30); // September
    expect(days(monthGrid(2026, 1, {}))).toHaveLength(28); // February 2026
    expect(days(monthGrid(2024, 1, {}))).toHaveLength(29); // February 2024, leap
  });

  test('the selected day and today are marked apart', () => {
    const grid = monthGrid(2026, 7, { selected: '2026-08-21', today: '2026-08-14' });
    const find = (iso) => grid.find((cell) => cell.iso === iso);
    expect(find('2026-08-21')).toMatchObject({ selected: true, today: false });
    expect(find('2026-08-14')).toMatchObject({ selected: false, today: true });
    expect(find('2026-08-01')).toMatchObject({ selected: false, today: false });
  });

  test('a day can be both today and selected', () => {
    const grid = monthGrid(2026, 7, { selected: '2026-08-21', today: '2026-08-21' });
    expect(grid.find((c) => c.iso === '2026-08-21')).toMatchObject({ selected: true, today: true });
  });

  test('days outside min and max are disabled, inclusive at both ends', () => {
    const grid = monthGrid(2026, 7, { min: '2026-08-10', max: '2026-08-20' });
    const at = (iso) => grid.find((cell) => cell.iso === iso).disabled;
    expect(at('2026-08-09')).toBe(true);
    expect(at('2026-08-10')).toBe(false);
    expect(at('2026-08-20')).toBe(false);
    expect(at('2026-08-21')).toBe(true);
  });

  test('no bounds means no day is disabled', () => {
    // The blanks stay disabled either way — see the cell shape. This is about
    // the days.
    expect(days(monthGrid(2026, 7, {})).some((cell) => cell.disabled)).toBe(false);
  });

  test('every day carries a spoken label, because a bare number is not one', () => {
    const grid = monthGrid(2026, 7, {});
    expect(grid.find((cell) => cell.iso === '2026-08-21').label).toBe('Friday 21 August');
  });

  test('the blanks carry nothing to click or read', () => {
    const blank = monthGrid(2026, 7, {})[0];
    expect(blank).toMatchObject({ empty: true, iso: null, day: null, disabled: true });
  });

  test('grid cells are unique by key, so a re-render cannot duplicate a day', () => {
    const grid = monthGrid(2026, 7, {});
    expect(new Set(grid.map((cell) => cell.key)).size).toBe(grid.length);
  });
});

describe('todayInPerth', () => {
  test('it reads the Perth day, not the UTC one', () => {
    // 23:30 UTC on the 21st is 07:30 on the 22nd in Perth. A picker opening on
    // the UTC day marks the wrong cell "today" for eight hours of every day.
    expect(todayInPerth('2026-08-21T23:30:00Z')).toBe('2026-08-22');
    expect(todayInPerth('2026-08-21T14:00:00+08:00')).toBe('2026-08-21');
  });

  test('an unreadable instant gets null rather than a wrong day', () => {
    expect(todayInPerth('not a date')).toBe(null);
  });
});
