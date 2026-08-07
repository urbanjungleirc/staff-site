import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

// The create confirmation is Alpine markup inside index.html, so these read the
// source — there is no module to import, the way type-surfaces.test.js has one.
//
// Be clear about what that can prove: these assert the markup SAYS the right
// thing, not that a browser renders it. A gate that is correct here can still
// never appear (hidden ancestor, is_physical absent from the response). What
// they do catch is the rule going missing or being re-pointed at the form —
// which is what issue #55 is about.
function successBanner() {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const block = html.match(/<!-- Success banner -->([\s\S]*?)<!-- Error banner -->/);
  if (!block) throw new Error('could not find the create success banner in index.html');
  return block[1];
}

const GATE = 'x-show="createdVoucher?.is_physical"';

// The reminder element, taken by walking <div> depth out from its gate, so an
// added wrapper or a reflow cannot quietly shrink what the assertions below see.
function writeOnCardReminder() {
  const banner = successBanner();
  const gate = banner.indexOf(GATE);
  if (gate === -1) throw new Error(`no element gated on ${GATE} in the success banner`);
  const start = banner.lastIndexOf('<div', gate);
  const tags = /<(\/?)div\b/g;
  tags.lastIndex = start;
  let depth = 0;
  for (let m = tags.exec(banner); m; m = tags.exec(banner)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return banner.slice(start, banner.indexOf('>', m.index) + 1);
  }
  throw new Error('unbalanced <div> around the write-on-card reminder');
}

describe('physical voucher: write-the-code reminder', () => {
  it('is shown only when the created voucher is physical', () => {
    expect(successBanner()).toContain(GATE);
  });

  it('gates on the created voucher, not the create form', () => {
    // createType survives a submit so staff can issue several of a kind. Gating
    // on it would keep the reminder up against a stale form selection.
    expect(writeOnCardReminder()).not.toMatch(/createType/);
  });

  it('tells staff what to write, and where', () => {
    expect(writeOnCardReminder()).toMatch(/write this code on the voucher card/i);
  });

  it('renders the code inside the reminder, so it is copied from the instruction itself', () => {
    expect(writeOnCardReminder()).toContain('x-text="createdVoucher?.voucher_id"');
  });

  it('never names the old habit it is displacing', () => {
    // Deliberate: staff who never wrote the Clubworx receipt on a card must not
    // learn from this banner that anyone did. See issue #55.
    expect(successBanner()).not.toMatch(/clubworx/i);
  });
});
