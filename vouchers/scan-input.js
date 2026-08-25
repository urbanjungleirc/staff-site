// vouchers/scan-input.js
// Turning keystrokes from the front-desk scanner into a voucher code, and a
// voucher into a destination. Pure on purpose — no DOM, no network — so the
// rules are unit-testable and the page holds nothing but wiring.
//
// The scanner (Zebra DS2208) is a USB keyboard as far as the browser is
// concerned: it types the code and presses Enter. There is no device to talk
// to and no event that says "a scan happened" — only characters arriving with
// nothing focused. See docs/adr/0006-voucher-scanning-is-a-keyboard-wedge.md
// for why it is built this way and what was rejected.

// The voucher code format is DECIDED IN THE VOUCHERS REPO — its ADR 0004, and
// randomVoucherCode() in cloudflare/payments-worker/src/voucher-codes.js. This
// regex is a knowing second copy of that decision, not a source of truth.
//
// It is duplicated rather than asked for because the alternative is a network
// round-trip in front of every stray scan, just to be told it was not a
// voucher. IF THE FORMAT EVER CHANGES, THIS IS THE SECOND PLACE.
//
// Deliberately the loose form: [A-Z0-9], not the generator's reduced alphabet
// (which omits I, O, 0 and 1 so humans do not misread them). A code that
// somehow contains one is a code we should still look up — the tighter test
// would turn a lookup into a silent refusal, and the Worker is the thing that
// actually knows whether a voucher exists.
export const VOUCHER_CODE = /^UJ-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

// Migrated GAS-era vouchers kept their UUID codes and are deliberately NOT
// matched here: those emails never carried a QR, so there is nothing to point a
// scanner at. They are found through the search box like any other text.
export function isScannableCode(text) {
  return VOUCHER_CODE.test(normaliseScanned(text));
}

// Everything is normalised before it is tested, so the app depends on nothing
// about the scanner beyond "characters, then Enter". A till with Caps Lock on,
// or a replacement unit someone else programmed, still works.
export function normaliseScanned(text) {
  return typeof text === 'string' ? text.trim().toUpperCase() : '';
}

// A burst shorter than this on Enter is treated as noise and passes in silence.
// It is a heuristic against stray keypresses, not a rule about voucher codes —
// a real code is 12 characters and a scanned barcode of any kind is longer than
// four. Without it, every bare Enter pressed with nothing focused would tell a
// staff member that something is not a voucher code.
export const MIN_MEANINGFUL_LENGTH = 4;

// Guards against a buffer growing without bound if someone types at a page with
// nothing focused. The tail is kept rather than the head: if anything useful is
// in there, it is what arrived most recently.
export const MAX_BUFFER = 64;

// Accumulates keystrokes until Enter, then reports what it has.
//
// Returns null while there is nothing to say, and a result object on Enter:
//   { type: 'code', code }        a scannable voucher code
//   { type: 'unrecognised', text } enough characters to be a real attempt, but
//                                  not a voucher code — worth saying so
//
// THE TRAP THIS EXISTS TO AVOID (measured 2026-08-25, ADR 0006): a 12-character
// code arrives as 22 keydown events, because the scanner presses Shift before
// every letter exactly as a person would. Appending e.key on every keydown
// builds "ShiftUShiftJ-ShiftT…". Only single-character keys are collected.
// Nothing else about Shift needs handling — e.key is already "U", not "u".
export function createScanBuffer() {
  let chars = [];

  return {
    // Pass event.key, not the event: the module stays DOM-free and a test can
    // drive it with plain strings.
    push(key) {
      if (typeof key !== 'string') return null;

      if (key === 'Enter') {
        const text = normaliseScanned(chars.join(''));
        chars = [];
        if (text.length < MIN_MEANINGFUL_LENGTH) return null;
        return VOUCHER_CODE.test(text)
          ? { type: 'code', code: text }
          : { type: 'unrecognised', text };
      }

      // Escape abandons whatever has accumulated. Cheap, and it gives a staff
      // member a way out if a half-read scan has left junk in the buffer.
      if (key === 'Escape') {
        chars = [];
        return null;
      }

      // Shift, Control, Tab, ArrowLeft, F5 — every non-printable key. Dropped
      // rather than treated as a terminator: only Enter ends a scan, so a
      // modifier landing mid-code cannot truncate it.
      if (key.length !== 1) return null;

      chars.push(key);
      if (chars.length > MAX_BUFFER) chars = chars.slice(-MAX_BUFFER);
      return null;
    },

    // What has accumulated so far. For tests and debugging; the page does not
    // render it — a half-typed buffer on screen would be noise.
    pending() {
      return chars.join('');
    },

    reset() {
      chars = [];
    },
  };
}

// Where a scanned or typed voucher code should land.
//
// Returns one of:
//   { action: 'not-found' }
//   { action: 'redeem' }
//   { action: 'blocked', reason, message }
//
// `reason` is a key rather than a colour or a class. The hub runs on the
// Tailwind Play CDN, which cannot generate a class name computed in JavaScript,
// so the banner's colours are literal in the markup and gated on this key.
export function scanOutcome(voucher) {
  if (!voucher) return { action: 'not-found' };

  // ONE test, not two. A partially redeemed voucher keeps status 'active' for
  // as long as it has balance, and is redeemable — the "Partially redeemed"
  // badge is informational and reads more terminal than it is. This is the same
  // gate the Redeem button already uses, deliberately.
  if (voucher.status === 'active') return { action: 'redeem' };

  return { action: 'blocked', ...blocked(voucher.status) };
}

function blocked(status) {
  switch (status) {
    case 'expired':
      return { reason: 'expired', message: 'This voucher has expired — it can no longer be redeemed.' };
    case 'cancelled':
      return { reason: 'cancelled', message: 'This voucher was cancelled — it can no longer be redeemed.' };
    case 'redeemed':
      return { reason: 'no-balance', message: 'This voucher has no balance left — it is fully redeemed.' };
    // A status the Worker's voucher_derived_status() grew and this page has not
    // learned yet. Refuse rather than fall through to the redeem form: an
    // unknown status is not a licence to take money off a voucher.
    default:
      return { reason: 'unknown', message: 'This voucher is not redeemable.' };
  }
}
