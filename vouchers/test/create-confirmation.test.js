import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

// The create confirmation lives in index.html's Alpine markup, so these read
// the source the same way type-surfaces.test.js reads blankTypeForm() — the
// rules being asserted have no module to import.
function successBanner() {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const block = html.match(/<!-- Success banner -->([\s\S]*?)<!-- Error banner -->/);
  if (!block) throw new Error('could not find the create success banner in index.html');
  return block[1];
}

describe('physical voucher: write-the-code reminder', () => {
  it('is shown only when the created voucher is physical', () => {
    const banner = successBanner();
    expect(banner).toMatch(/x-show="createdVoucher\?\.is_physical"/);
  });

  it('gates on the created voucher, not the create form', () => {
    // createType survives a submit so staff can issue several of a kind. Gating
    // on it would keep the reminder on screen against a stale form selection.
    const banner = successBanner();
    expect(banner).not.toMatch(/createType/);
  });

  it('tells staff what to write, and where', () => {
    const banner = successBanner();
    const reminder = banner.match(/x-show="createdVoucher\?\.is_physical"[\s\S]*?<\/div>\s*<\/div>/);
    expect(reminder).toBeTruthy();
    expect(reminder[0]).toMatch(/write/i);
    expect(reminder[0]).toMatch(/voucher/i);
  });

  it('renders the code inside the reminder, so it is copied from the instruction itself', () => {
    const banner = successBanner();
    const reminder = banner.match(/x-show="createdVoucher\?\.is_physical"[\s\S]*?<\/div>\s*<\/div>/);
    expect(reminder[0]).toMatch(/x-text="createdVoucher\?\.voucher_id"/);
  });

  it('never names the old habit it is displacing', () => {
    // Deliberate: staff who never wrote the Clubworx receipt on a card must not
    // learn from this banner that anyone did. See issue #55.
    expect(successBanner()).not.toMatch(/clubworx/i);
  });
});
