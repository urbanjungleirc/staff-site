import { describe, expect, test } from 'vitest';
import {
  VOUCHER_CODE,
  isScannableCode,
  normaliseScanned,
  createScanBuffer,
  scanOutcome,
  MIN_MEANINGFUL_LENGTH,
  MAX_BUFFER,
} from '../scan-input.js';

// The keystrokes a real DS2208 sends, measured 2026-08-25 against a live
// voucher and recorded in ADR 0006. Every letter is preceded by its own
// ShiftLeft keydown; digits and hyphens are not. Twenty-two events for twelve
// characters. Tests drive the buffer with THIS, not with a clean string, or
// they prove nothing about the thing that actually happens at the counter.
function scannerKeys(code) {
  const keys = [];
  for (const ch of code) {
    if (/[A-Z]/.test(ch)) keys.push('Shift');
    keys.push(ch);
  }
  keys.push('Enter');
  return keys;
}

function feed(buffer, keys) {
  let last = null;
  for (const k of keys) last = buffer.push(k);
  return last;
}

describe('the shape of a scannable code', () => {
  test('accepts a real code', () => {
    // Both measured live: TQYH-F8PW off a phone screen, YVZ6-H98L off another.
    expect(isScannableCode('UJ-TQYH-F8PW')).toBe(true);
    expect(isScannableCode('UJ-YVZ6-H98L')).toBe(true);
  });

  test('normalises before testing, so casing and stray spaces do not matter', () => {
    expect(isScannableCode('  uj-tqyh-f8pw  ')).toBe(true);
    expect(normaliseScanned('  uj-tqyh-f8pw  ')).toBe('UJ-TQYH-F8PW');
  });

  // The app depends on nothing about the scanner beyond "characters, then
  // Enter". A till left on Caps Lock is the case this covers.
  test('a lowercase burst is still a code', () => {
    expect(isScannableCode('uj-tqyh-f8pw')).toBe(true);
  });

  test('rejects the wrong shape', () => {
    expect(isScannableCode('UJ-TQYH-F8P')).toBe(false);    // too short
    expect(isScannableCode('UJ-TQYH-F8PWX')).toBe(false);  // too long
    expect(isScannableCode('UJTQYHF8PW')).toBe(false);     // hyphens gone
    expect(isScannableCode('XX-TQYH-F8PW')).toBe(false);   // not ours
    expect(isScannableCode('9312345678903')).toBe(false);  // a product barcode
    expect(isScannableCode('')).toBe(false);
  });

  test('rejects a legacy UUID voucher on purpose', () => {
    // Migrated GAS-era vouchers kept UUID codes, and those emails never carried
    // a QR — there is nothing to scan. Widening the test would loosen it for no
    // reachable benefit. They stay a search-box job.
    expect(isScannableCode('3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBe(false);
  });

  // The generator omits I, O, 0 and 1 so humans do not misread them, but this
  // test is deliberately looser than the generator. A code containing one
  // should still be looked up — the Worker knows whether a voucher exists, and
  // a tighter regex here would turn that lookup into a silent refusal.
  test('does not enforce the generator’s reduced alphabet', () => {
    expect(isScannableCode('UJ-I0O1-ABCD')).toBe(true);
  });

  test('is anchored at both ends', () => {
    expect(VOUCHER_CODE.test('XUJ-TQYH-F8PW')).toBe(false);
    expect(VOUCHER_CODE.test('UJ-TQYH-F8PWX')).toBe(false);
  });

  test('a non-string is not a code', () => {
    expect(isScannableCode(null)).toBe(false);
    expect(isScannableCode(undefined)).toBe(false);
    expect(isScannableCode(12)).toBe(false);
  });
});

describe('the scan buffer', () => {
  // THE test. If this passes with the Shift keydowns interleaved, the trap that
  // ADR 0006 records is closed.
  test('reads a code out of the keystrokes a real scanner sends', () => {
    const buffer = createScanBuffer();
    const keys = scannerKeys('UJ-TQYH-F8PW');

    expect(keys).toHaveLength(22);   // 12 characters, 22 events
    expect(feed(buffer, keys)).toEqual({ type: 'code', code: 'UJ-TQYH-F8PW' });
  });

  test('says nothing until Enter arrives', () => {
    const buffer = createScanBuffer();
    const keys = scannerKeys('UJ-TQYH-F8PW');
    for (const k of keys.slice(0, -1)) expect(buffer.push(k)).toBeNull();
    expect(buffer.push('Enter')).toEqual({ type: 'code', code: 'UJ-TQYH-F8PW' });
  });

  test('drops every non-printable key rather than treating it as a terminator', () => {
    const buffer = createScanBuffer();
    // A modifier landing mid-code must not truncate it.
    feed(buffer, ['U', 'J', 'Shift', '-', 'Control', 'T', 'Q', 'Y', 'H', 'ArrowLeft', '-', 'F', '8', 'P', 'F5', 'W']);
    expect(buffer.pending()).toBe('UJ-TQYH-F8PW');
    expect(buffer.push('Enter')).toEqual({ type: 'code', code: 'UJ-TQYH-F8PW' });
  });

  test('reports something that is not a voucher code', () => {
    const buffer = createScanBuffer();
    expect(feed(buffer, [...'9312345678903', 'Enter']))
      .toEqual({ type: 'unrecognised', text: '9312345678903' });
  });

  // Without this, every bare Enter pressed with nothing focused tells a staff
  // member that something is not a voucher code.
  test('passes a short burst over in silence', () => {
    const buffer = createScanBuffer();
    expect(buffer.push('Enter')).toBeNull();
    expect(feed(buffer, ['A', 'Enter'])).toBeNull();
    expect(feed(buffer, [...'ABC', 'Enter'])).toBeNull();
  });

  test('speaks up at exactly the meaningful length', () => {
    const buffer = createScanBuffer();
    const text = 'A'.repeat(MIN_MEANINGFUL_LENGTH);
    expect(feed(buffer, [...text, 'Enter'])).toEqual({ type: 'unrecognised', text });
  });

  test('clears itself after Enter, whatever the verdict', () => {
    const buffer = createScanBuffer();
    feed(buffer, [...'UJ-TQYH-F8PW', 'Enter']);
    expect(buffer.pending()).toBe('');

    feed(buffer, [...'rubbish', 'Enter']);
    expect(buffer.pending()).toBe('');

    // So a second scan is read on its own, not appended to the first.
    expect(feed(buffer, scannerKeys('UJ-YVZ6-H98L')))
      .toEqual({ type: 'code', code: 'UJ-YVZ6-H98L' });
  });

  test('Escape abandons what has accumulated', () => {
    const buffer = createScanBuffer();
    feed(buffer, [...'UJ-TQYH']);
    expect(buffer.push('Escape')).toBeNull();
    expect(buffer.pending()).toBe('');
  });

  test('reset() empties it', () => {
    const buffer = createScanBuffer();
    feed(buffer, [...'UJ-TQYH']);
    buffer.reset();
    expect(buffer.pending()).toBe('');
  });

  test('keeps the tail when it overflows, and drops the head', () => {
    const buffer = createScanBuffer();
    feed(buffer, [...'X'.repeat(MAX_BUFFER)]);
    expect(buffer.pending()).toBe('X'.repeat(MAX_BUFFER));

    // Whatever arrived most recently is what survives — if anything useful is
    // in a runaway buffer, it is what was typed last.
    feed(buffer, [...'UJ-TQYH-F8PW']);
    const pending = buffer.pending();
    expect(pending).toHaveLength(MAX_BUFFER);
    expect(pending.endsWith('UJ-TQYH-F8PW')).toBe(true);
    expect(pending.startsWith('X'.repeat(MAX_BUFFER - 12))).toBe(true);
    expect(pending).not.toContain('X'.repeat(MAX_BUFFER));
  });

  test('ignores a non-string key', () => {
    const buffer = createScanBuffer();
    expect(buffer.push(null)).toBeNull();
    expect(buffer.push(undefined)).toBeNull();
    expect(buffer.pending()).toBe('');
  });

  test('two buffers do not share state', () => {
    const a = createScanBuffer();
    const b = createScanBuffer();
    feed(a, [...'UJ-TQYH']);
    expect(b.pending()).toBe('');
  });
});

describe('where a scanned voucher lands', () => {
  test('an active voucher goes to the redeem form', () => {
    expect(scanOutcome({ status: 'active', balance: 50 })).toEqual({ action: 'redeem' });
  });

  // The reason this is one test and not two. A partially redeemed voucher keeps
  // status 'active' while it has balance; the "Partially redeemed" badge is
  // informational and reads more terminal than it is.
  test('a partially redeemed voucher is still redeemable', () => {
    expect(scanOutcome({ status: 'active', balance: 20, value: 50, last_redeemed_amount: 30 }))
      .toEqual({ action: 'redeem' });
  });

  // An unsent voucher is active and redeemable — a member must not lose an
  // entitlement because an email bounced.
  test('an unsent voucher is redeemable', () => {
    expect(scanOutcome({ status: 'active', balance: 50, email_sent: false }))
      .toEqual({ action: 'redeem' });
  });

  test('no voucher is not-found', () => {
    expect(scanOutcome(null)).toEqual({ action: 'not-found' });
    expect(scanOutcome(undefined)).toEqual({ action: 'not-found' });
  });

  test('each blocked status carries its own reason', () => {
    expect(scanOutcome({ status: 'expired' }).reason).toBe('expired');
    expect(scanOutcome({ status: 'cancelled' }).reason).toBe('cancelled');
    expect(scanOutcome({ status: 'redeemed' }).reason).toBe('no-balance');
  });

  test('every blocked outcome says why, in words a customer can hear', () => {
    for (const status of ['expired', 'cancelled', 'redeemed']) {
      const out = scanOutcome({ status });
      expect(out.action).toBe('blocked');
      expect(out.message).toMatch(/redeem/i);
      expect(out.message.length).toBeGreaterThan(20);
    }
  });

  // An unknown status is not a licence to take money off a voucher. If the
  // Worker's voucher_derived_status() grows a state this page has not learned,
  // it must refuse rather than fall through.
  test('an unrecognised status is refused, not waved through', () => {
    const out = scanOutcome({ status: 'on_hold' });
    expect(out.action).toBe('blocked');
    expect(out.reason).toBe('unknown');
  });

  test('a voucher with no status at all is refused', () => {
    expect(scanOutcome({ balance: 50 }).action).toBe('blocked');
  });

  // The reason must stay a key. The hub runs on the Tailwind Play CDN, which
  // cannot generate a class name computed in JavaScript, so the banner colours
  // are literal in the markup and gated on this value.
  test('the reason is a key, not a colour or a class', () => {
    for (const status of ['expired', 'cancelled', 'redeemed', 'whatever']) {
      const { reason } = scanOutcome({ status });
      expect(reason).toMatch(/^[a-z-]+$/);
      expect(reason).not.toMatch(/amber|rose|sky|bg-|text-/);
    }
  });
});
