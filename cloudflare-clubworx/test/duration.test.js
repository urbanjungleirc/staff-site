import { describe, it, expect } from 'vitest';
import { parsePlanDuration, passCoverageEnd, addDays, isRealDay } from '../src/duration.js';

describe('parsePlanDuration', () => {
  it('parses the plan UJ actually runs', () => {
    expect(parsePlanDuration('26 weeks')).toMatchObject({ ok: true, count: 26, unit: 'week' });
  });

  it('parses the duration the pass ran before ADR 0005', () => {
    expect(parsePlanDuration('12 weeks')).toMatchObject({ ok: true, count: 12, unit: 'week' });
  });

  it('parses a singular unit', () => {
    expect(parsePlanDuration('1 week')).toMatchObject({ ok: true, count: 1, unit: 'week' });
    expect(parsePlanDuration('1 month')).toMatchObject({ ok: true, count: 1, unit: 'month' });
  });

  it('parses days, months and years', () => {
    expect(parsePlanDuration('84 days')).toMatchObject({ ok: true, count: 84, unit: 'day' });
    expect(parsePlanDuration('3 months')).toMatchObject({ ok: true, count: 3, unit: 'month' });
    expect(parsePlanDuration('1 year')).toMatchObject({ ok: true, count: 1, unit: 'year' });
  });

  it('tolerates case and surrounding whitespace, because it is a human string', () => {
    expect(parsePlanDuration('  26 Weeks ')).toMatchObject({ ok: true, count: 26, unit: 'week' });
  });

  it('refuses rather than guessing at anything it does not recognise', () => {
    for (const raw of ['a term', '', null, undefined, 'weeks', '26', 'twenty-six weeks', {}]) {
      expect(parsePlanDuration(raw).ok).toBe(false);
    }
  });

  it('keeps the raw value on a refusal, because the warning has to name it', () => {
    expect(parsePlanDuration('a term')).toMatchObject({ ok: false, raw: 'a term' });
  });

  it('refuses a zero or negative count — a pass covering nothing is a misconfiguration', () => {
    expect(parsePlanDuration('0 weeks').ok).toBe(false);
    expect(parsePlanDuration('-4 weeks').ok).toBe(false);
  });
});

describe('passCoverageEnd', () => {
  // Measured, #60/#63: a 12-week pass starting 2026-08-20 expires 2026-11-11 —
  // 84 days of access, inclusive at both ends, so 83 days of difference.
  it('reproduces the measured 12-week expiry exactly', () => {
    expect(passCoverageEnd('2026-08-20', parsePlanDuration('12 weeks'))).toBe('2026-11-11');
  });

  it('gives the 26-week plan 182 days of access, inclusive', () => {
    expect(passCoverageEnd('2026-08-20', parsePlanDuration('26 weeks'))).toBe('2027-02-17');
  });

  it('counts a one-day pass as covering its own start day', () => {
    expect(passCoverageEnd('2026-08-20', parsePlanDuration('1 day'))).toBe('2026-08-20');
  });

  it('does calendar arithmetic for months and years, not 30-day approximations', () => {
    expect(passCoverageEnd('2026-01-31', parsePlanDuration('1 month'))).toBe('2026-02-27');
    expect(passCoverageEnd('2026-08-20', parsePlanDuration('1 year'))).toBe('2027-08-19');
  });

  it('answers null for a duration that did not parse, rather than a plausible date', () => {
    expect(passCoverageEnd('2026-08-20', parsePlanDuration('a term'))).toBeNull();
    expect(passCoverageEnd('not-a-day', parsePlanDuration('26 weeks'))).toBeNull();
  });
});

describe('addDays', () => {
  it('crosses a month boundary', () => {
    expect(addDays('2026-08-30', 3)).toBe('2026-09-02');
  });

  it('crosses a year boundary', () => {
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
  });

  it('handles a leap day', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });
});

describe('isRealDay', () => {
  it('accepts an ISO day', () => {
    expect(isRealDay('2026-08-20')).toBe(true);
  });

  it('rejects a day that rolls forward rather than throwing', () => {
    // new Date('2009-02-30') silently becomes 2 March.
    expect(isRealDay('2009-02-30')).toBe(false);
  });

  it('rejects anything that is not YYYY-MM-DD', () => {
    for (const value of ['20/08/2026', '2026-8-20', '2026-08-20T00:00:00Z', '', null, 20260820]) {
      expect(isRealDay(value)).toBe(false);
    }
  });
});
