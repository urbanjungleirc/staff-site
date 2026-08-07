import { describe, expect, test } from 'vitest';
import {
  codeConfirmed,
  canSubmitDelete,
  deleteWarnings,
  deleteErrorMessage,
  withoutVoucher,
} from '../delete-logic.js';

// Hard delete is irreversible and unguarded by any eligibility rule — the Worker
// deletes whatever the allowlisted account names. Everything standing between a
// mis-click and a lost voucher lives in these functions, so they are pinned here
// rather than left to an Alpine expression that nothing can execute.
// See 2026-08-05-voucher-hard-delete-design.md (section 3) in the vouchers hub.

describe('codeConfirmed', () => {
  test('accepts the code typed exactly', () => {
    expect(codeConfirmed('UJ-WF36-4FWE', 'UJ-WF36-4FWE')).toBe(true);
  });

  test('accepts case and surrounding whitespace differences', () => {
    // Codes are displayed uppercase but typed by hand, and a trailing space from
    // a double-click copy is not a different voucher.
    expect(codeConfirmed('  uj-wf36-4fwe  ', 'UJ-WF36-4FWE')).toBe(true);
  });

  test('rejects a partial or near-miss code', () => {
    expect(codeConfirmed('UJ-WF36', 'UJ-WF36-4FWE')).toBe(false);
    expect(codeConfirmed('UJ-WF36-4FW', 'UJ-WF36-4FWE')).toBe(false);
    expect(codeConfirmed('UJ-WF36-4FWF', 'UJ-WF36-4FWE')).toBe(false);
  });

  test('rejects blank input, whatever the voucher', () => {
    expect(codeConfirmed('', 'UJ-WF36-4FWE')).toBe(false);
    expect(codeConfirmed('   ', 'UJ-WF36-4FWE')).toBe(false);
  });

  test('never confirms when there is no voucher code to match', () => {
    // Otherwise an empty box would match an empty code and enable the button.
    expect(codeConfirmed('', '')).toBe(false);
    expect(codeConfirmed('', null)).toBe(false);
    expect(codeConfirmed('anything', undefined)).toBe(false);
  });
});

describe('canSubmitDelete', () => {
  const ok = {
    voucher: { voucher_id: 'UJ-WF36-4FWE' },
    typedCode: 'UJ-WF36-4FWE',
    reason: 'test voucher',
    busy: false,
  };

  test('allows submission once code and reason are both given', () => {
    expect(canSubmitDelete(ok)).toBe(true);
  });

  test('blocks until the code matches', () => {
    expect(canSubmitDelete({ ...ok, typedCode: 'UJ-WF36' })).toBe(false);
  });

  test('blocks on a missing or whitespace-only reason', () => {
    expect(canSubmitDelete({ ...ok, reason: '' })).toBe(false);
    expect(canSubmitDelete({ ...ok, reason: '   ' })).toBe(false);
  });

  test('blocks while a delete is already in flight', () => {
    // Double-submitting sends a second DELETE that 404s and reads as an error
    // on a delete that in fact succeeded.
    expect(canSubmitDelete({ ...ok, busy: true })).toBe(false);
  });

  test('blocks when there is no voucher loaded', () => {
    expect(canSubmitDelete({ ...ok, voucher: null })).toBe(false);
  });
});

describe('deleteWarnings', () => {
  test('says nothing for a voucher with no transaction history', () => {
    expect(deleteWarnings({ voucher_id: 'UJ-AAAA-BBBB', value: 50, balance: 50 })).toEqual([]);
  });

  test('warns when the voucher has been redeemed', () => {
    const warnings = deleteWarnings({ value: 50, balance: 50, last_redeemed_amount: 20 });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/redeemed/i);
  });

  test('warns on a spent-down balance even without a last-redeemed amount', () => {
    // Migrated v2 rows carry the reduced balance but not the per-redemption
    // fields, so balance drift is the more reliable of the two signals.
    expect(deleteWarnings({ value: 50, balance: 30 })).toHaveLength(1);
  });

  test('warns when a payment reference means real money was taken', () => {
    const warnings = deleteWarnings({
      value: 50,
      balance: 50,
      payment_platform: 'stripe',
      payment_reference: 'pi_3QabcXYZ',
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/paid/i);
  });

  test('warns about both when a paid voucher has also been redeemed', () => {
    expect(deleteWarnings({
      value: 50,
      balance: 0,
      last_redeemed_amount: 50,
      payment_reference: 'pi_3QabcXYZ',
    })).toHaveLength(2);
  });

  test('ignores a blank payment reference', () => {
    expect(deleteWarnings({ value: 50, balance: 50, payment_reference: '  ' })).toEqual([]);
  });

  test('tolerates a missing voucher rather than throwing into the modal', () => {
    expect(deleteWarnings(null)).toEqual([]);
  });
});

describe('deleteErrorMessage', () => {
  test('names the allowlist on a 403, not the staff gate', () => {
    // 401 means "signed out"; 403 means "signed in as the wrong person". Telling
    // someone to sign in again when the answer is that their address is not
    // allowed sends them round a loop that can never succeed.
    const message = deleteErrorMessage({ status: 403, message: 'forbidden' });

    expect(message).toMatch(/authorised account/i);
    expect(message).not.toMatch(/expired|sign in again/i);
  });

  test('passes the session-expiry message through untouched on a 401', () => {
    expect(deleteErrorMessage({ status: 401, message: 'Your session expired — reload the page to sign in again.' }))
      .toBe('Your session expired — reload the page to sign in again.');
  });

  test('surfaces the server text for a 400 or 404', () => {
    expect(deleteErrorMessage({ status: 400, message: 'reason is required' })).toBe('reason is required');
    expect(deleteErrorMessage({ status: 404, message: 'Voucher not found' })).toBe('Voucher not found');
  });

  test('falls back to a readable line when the error carries no message', () => {
    expect(deleteErrorMessage({ status: 500 })).toMatch(/delete/i);
    expect(deleteErrorMessage(null)).toMatch(/delete/i);
  });
});

describe('withoutVoucher', () => {
  const results = [
    { voucher_id: 'UJ-AAAA-1111' },
    { voucher_id: 'UJ-BBBB-2222' },
    { voucher_id: 'UJ-CCCC-3333' },
  ];

  test('drops the deleted row so the stale list does not outlive the voucher', () => {
    expect(withoutVoucher(results, 'UJ-BBBB-2222').map((r) => r.voucher_id))
      .toEqual(['UJ-AAAA-1111', 'UJ-CCCC-3333']);
  });

  test('leaves the list alone when the code is not in it', () => {
    expect(withoutVoucher(results, 'UJ-ZZZZ-9999')).toHaveLength(3);
  });

  test('returns a new array rather than mutating the one passed in', () => {
    const out = withoutVoucher(results, 'UJ-AAAA-1111');

    expect(out).not.toBe(results);
    expect(results).toHaveLength(3);
  });

  test('tolerates a list that has not loaded yet', () => {
    expect(withoutVoucher(null, 'UJ-AAAA-1111')).toEqual([]);
    expect(withoutVoucher(undefined, 'UJ-AAAA-1111')).toEqual([]);
  });
});
