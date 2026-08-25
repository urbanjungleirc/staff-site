import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';

// scan-input.js is a real module and is called directly in scan-input.test.js.
// These read the page source instead. Be clear about what that proves: they
// assert the markup ASKS the right question and wires the listener where it
// should be, not that a browser dispatches anything. What they catch is the
// listener being dropped, the suppression rules being loosened, or the camera
// scanner coming back.

const page = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

describe('the camera scanner is gone', () => {
  // It was unreachable dead code — goScan() had no caller anywhere in the repo
  // — and it loaded a third-party script from unpkg onto a page behind Access.
  // Deleted in #136; ADR 0006 records why. These stop it drifting back.
  test('no html5-qrcode script is loaded', () => {
    expect(page).not.toContain('html5-qrcode');
    expect(page).not.toContain('Html5Qrcode');
  });

  test('no unpkg script of any kind is loaded', () => {
    expect(page).not.toContain('unpkg.com');
  });

  test('there is no scan view, and nothing left to route to it', () => {
    expect(page).not.toContain("view==='scan'");
    expect(page).not.toContain('qr-reader');
    for (const gone of ['goScan', 'startScanner', 'stopScannerIfActive', 'lookupManual', 'manualCode']) {
      expect(page).not.toContain(gone);
    }
  });
});
