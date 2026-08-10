import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { addDays, EXPIRING_SOON_DAYS, isExpiringSoon } from '../expiry-flag.js';

const TODAY = '2026-08-10';
const active = (expiry_date) => ({ status: 'active', expiry_date });

describe('addDays', () => {
  test('crosses a month end', () => {
    expect(addDays('2026-08-10', 30)).toBe('2026-09-09');
  });

  test('crosses a year end', () => {
    expect(addDays('2026-12-20', 30)).toBe('2027-01-19');
  });

  test('handles a leap day', () => {
    expect(addDays('2028-02-01', 30)).toBe('2028-03-02');
  });

  test('refuses anything that is not a plain date', () => {
    for (const bad of ['', '2026-8-10', '10/08/2026', '2026-08-10T00:00:00Z', null, undefined]) {
      expect(addDays(bad, 30)).toBe('');
    }
  });
});

describe('isExpiringSoon — the window', () => {
  test('a voucher expiring today still counts: it is redeemable all day', () => {
    expect(isExpiringSoon(active(TODAY), TODAY)).toBe(true);
  });

  test('the far edge of the window is inside it', () => {
    expect(isExpiringSoon(active(addDays(TODAY, EXPIRING_SOON_DAYS)), TODAY)).toBe(true);
  });

  test('one day past the window is not', () => {
    expect(isExpiringSoon(active(addDays(TODAY, EXPIRING_SOON_DAYS + 1)), TODAY)).toBe(false);
  });

  test('yesterday has already expired, and expired is not "expiring"', () => {
    // The whole point of the separation: an expired voucher has its own status
    // and must not also read as a caution about something yet to happen.
    expect(isExpiringSoon(active(addDays(TODAY, -1)), TODAY)).toBe(false);
  });

  test('a voucher that lapsed years ago is not dragged back in by a stale status', () => {
    expect(isExpiringSoon(active('2019-01-01'), TODAY)).toBe(false);
  });

  test('the window is the 30 days the dashboard counts', () => {
    expect(EXPIRING_SOON_DAYS).toBe(30);
  });
});

describe('isExpiringSoon — which vouchers qualify', () => {
  test('no expiry never qualifies', () => {
    for (const nothing of [null, '', undefined]) {
      expect(isExpiringSoon(active(nothing), TODAY)).toBe(false);
    }
  });

  test.each(['cancelled', 'redeemed', 'expired'])('a %s voucher is not usable, so it never flags', (status) => {
    expect(isExpiringSoon({ status, expiry_date: addDays(TODAY, 5) }, TODAY)).toBe(false);
  });

  test('a partly spent but still active voucher does flag — it is still usable', () => {
    expect(isExpiringSoon({ status: 'active', expiry_date: addDays(TODAY, 5), balance: 20, value: 50 }, TODAY))
      .toBe(true);
  });

  test('a timestamp in the expiry column is read as its date', () => {
    expect(isExpiringSoon(active(addDays(TODAY, 5) + 'T00:00:00+08:00'), TODAY)).toBe(true);
  });

  test('nothing is flagged without a voucher or a usable today', () => {
    expect(isExpiringSoon(null, TODAY)).toBe(false);
    expect(isExpiringSoon(active(TODAY), '')).toBe(false);
    expect(isExpiringSoon(active(TODAY), undefined)).toBe(false);
  });
});

describe('wiring into the page', () => {
  const page = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

  test('the module is imported and published like the others', () => {
    expect(page).toMatch(/import \* as expiryFlag from '\.\/expiry-flag\.js\?v=1';/);
    expect(page).toMatch(/window\.expiryFlag = expiryFlag;/);
  });

  test('the flag degrades to nothing if that module is missing', () => {
    // A stale cached copy costs the flag and nothing else — it must never be
    // able to throw on every render of the detail view.
    const method = page.slice(page.indexOf('isExpiringSoon(v) {'));
    expect(method.slice(0, 200)).toMatch(/window\.expiryFlag\?\.isExpiringSoon\?\./);
  });

  test('today is Perth today, not the machine clock', () => {
    const method = page.slice(page.indexOf('isExpiringSoon(v) {'));
    expect(method.slice(0, 200)).toMatch(/this\.perthToday\(\)/);
  });

  test('it renders beside the expiry date', () => {
    const start = page.indexOf('>Expires</dt>');
    expect(start).toBeGreaterThan(-1);
    const expiresRow = page.slice(start, page.indexOf('</div>', start));
    expect(expiresRow).toMatch(/fmtDate\(voucher\?\.expiry_date\)/);
    expect(expiresRow).toMatch(/x-show="isExpiringSoon\(voucher\)"/);
    expect(expiresRow).toMatch(/Expiring soon/);
    // Amber: a caution, matching the dashboard's expiring-soon counter. Not
    // rose — nothing has gone wrong yet.
    expect(expiresRow).toMatch(/amber/);
    expect(expiresRow).not.toMatch(/rose|red-/);
  });
});
