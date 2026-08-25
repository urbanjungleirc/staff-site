import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { isUnsent, unsentReason } from '../unsent-voucher.js';

// The predicate is a real module, so these call it. The three render sites are
// Alpine markup inside index.html and are pinned against the page source below
// — those assert the markup ASKS the right question, not that a browser paints
// it. What they catch is a site being added that invents its own condition.

const page = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

const emailed = (over = {}) => ({
  is_physical: false, customer_email: 'a@b.com', email_sent: true, ...over,
});

describe('isUnsent', () => {
  test('an emailed voucher whose send succeeded is not unsent', () => {
    expect(isUnsent(emailed())).toBe(false);
  });

  test('an emailed voucher whose send failed is unsent', () => {
    expect(isUnsent(emailed({ email_sent: false }))).toBe(true);
  });

  // The exclusion that matters most: every voucher issued at the front desk is
  // physical and carries email_sent: false forever, because no email was ever
  // due. Without this the badge is on the entire counter's output.
  test('a physical voucher is never unsent, however the flag reads', () => {
    expect(isUnsent({ is_physical: true, customer_email: 'a@b.com', email_sent: false })).toBe(false);
    expect(isUnsent({ is_physical: true, customer_email: null, email_sent: false })).toBe(false);
  });

  test('an emailed voucher with no address on file is not unsent', () => {
    // There is nothing to resend to, and the detail view already says so.
    expect(isUnsent(emailed({ customer_email: null, email_sent: false }))).toBe(false);
    expect(isUnsent(emailed({ customer_email: '', email_sent: false }))).toBe(false);
  });

  test('a missing or absent voucher does not flag', () => {
    expect(isUnsent(null)).toBe(false);
    expect(isUnsent(undefined)).toBe(false);
  });

  // A row written before the Worker recorded send state has the column absent
  // rather than false. It is still unsent — the flag is the fact, not its type.
  test('an absent email_sent column reads as unsent', () => {
    expect(isUnsent({ is_physical: false, customer_email: 'a@b.com' })).toBe(true);
  });
});

describe('unsentReason', () => {
  test('passes the Worker’s wording through unchanged', () => {
    const reason = 'The email address (a@b.com) was rejected as invalid. Please check it and try again.';
    expect(unsentReason({ send_last_error: reason })).toBe(reason);
  });

  test('is empty when nothing was recorded, so the line can be hidden', () => {
    expect(unsentReason({})).toBe('');
    expect(unsentReason({ send_last_error: null })).toBe('');
    expect(unsentReason({ send_last_error: '   ' })).toBe('');
    expect(unsentReason(null)).toBe('');
  });
});

describe('every render site asks the module, not its own condition', () => {
  // A site that inlines `!v.is_physical && !v.email_sent` would flag every
  // address-less voucher, and one that forgot is_physical would flag the whole
  // front desk. Both are the regression this pins.
  test('the create result, the detail view and the search list all call isUnsent()', () => {
    const calls = [...page.matchAll(/x-show="isUnsent\((\w+)\)"/g)].map((m) => m[1]);
    expect(calls).toEqual(expect.arrayContaining(['createdVoucher', 'voucher', 'v']));
    expect(calls).toHaveLength(3);
  });

  test('the page never open-codes the rule instead of calling it', () => {
    expect(page).not.toMatch(/!\w+\??\.?is_physical\s*&&[^"]*email_sent/);
  });

  test('the reason shown is the recorded one, not a generic sentence', () => {
    expect(page).toMatch(/x-text="unsentReason\(createdVoucher\)"/);
    expect(page).toMatch(/x-text="unsentReason\(voucher\)"/);
  });

  test('the helpers delegate to the module rather than reimplementing it', () => {
    // Anchored on the DEFINITION of the next method, not on a bare
    // `willEmailVoucher()` — that name appears in the markup long before
    // the component, and slicing to it yields an empty string that passes
    // the negative assertion for the wrong reason.
    const start = page.indexOf('isUnsent(v) {');
    const inline = page.slice(start, page.indexOf('willEmailVoucher() {', start));
    expect(inline).toMatch(/window\.unsentVoucher\?\.isUnsent/);
    expect(inline).not.toMatch(/email_sent/);
  });

  test('the module is loaded by the page', () => {
    expect(page).toMatch(/import \* as unsentVoucher from '\.\/unsent-voucher\.js\?v=\d+'/);
  });
});
