import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';

// scan-input.js is a real module and is called directly in scan-input.test.js.
// These read the page source instead. Be clear about what that proves: they
// assert the markup ASKS the right question and wires the listener where it
// should be, not that a browser dispatches anything. What they catch is the
// listener being dropped, the suppression rules being loosened, or the camera
// scanner coming back.

const page = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function between(start, end) {
  const from = page.indexOf(start);
  if (from < 0) throw new Error(`could not find ${start} in index.html`);
  const to = page.indexOf(end, from + start.length);
  if (to < 0) throw new Error(`could not find ${end} after ${start}`);
  return page.slice(from, to);
}

const onScanKey = () => between('onScanKey(e) {', '\n      },');
const openScannedCode = () => between('async openScannedCode(code) {', '\n      },');

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

  // Scanning is ambient — every screen, no navigation, nothing to switch on. A
  // button would imply you have to press something first, which is exactly what
  // the old disabled "Scan coming later" placeholder trained staff to think.
  test('there is no Scan control in the header', () => {
    const nav = between('<nav class="flex flex-col gap-1.5 sm:items-end">', '</nav>');
    expect(nav).not.toMatch(/>\s*Scan\s*</);
    // The attribute, not the phrase — the comment that replaced the button
    // quotes the old tooltip, and pinning the words would fail on the
    // explanation rather than on the control.
    expect(page).not.toContain('title="Scan coming later"');
  });

  test('there is no scan view, and nothing left to route to it', () => {
    expect(page).not.toContain("view==='scan'");
    expect(page).not.toContain('qr-reader');
    for (const gone of ['goScan', 'startScanner', 'stopScannerIfActive', 'lookupManual', 'manualCode']) {
      expect(page).not.toContain(gone);
    }
  });
});

describe('the listener is wired', () => {
  test('the module is imported and published for the component to read', () => {
    expect(page).toMatch(/import \* as scanInput from '\.\/scan-input\.js\?v=\d+'/);
    expect(page).toContain('window.scanInput = scanInput;');
  });

  // Bound in the markup rather than added in init(). A directive binds once per
  // element however often init() runs, which a bare addEventListener does not:
  // while the page carried x-data + x-init="init()" together, Alpine ran init()
  // twice (vouchers#70) and a listener attached there would have double-handled
  // every keystroke. The pairing is gone, but the reason to bind here stands.
  test('keydown is bound on the root, at window scope', () => {
    expect(page).toContain('@keydown.window="onScanKey($event)"');
    expect(between('x-data="staffApp()"', '>')).toContain('@keydown.window');
  });

  test('a missing module disables scanning instead of throwing', () => {
    // Every keystroke in the hub goes through this. Throwing here would break
    // typing, not just scanning.
    expect(page).toMatch(/const scanBuffer = window\.scanInput\?\.createScanBuffer\?\.\(\)/);
    expect(onScanKey()).toMatch(/^\s*if \(!scanBuffer\) return;/m);
  });

  // Alpine wraps its data in a reactive Proxy. The buffer is stateful and
  // nothing renders it, so it lives in the closure — see the comment there.
  test('the buffer is a closure variable, not component data', () => {
    const data = between('function staffApp() {', 'onScanKey(e) {');
    expect(data).toMatch(/^\s*const scanBuffer =/m);
    expect(page).not.toMatch(/scanBuffer:/);
    expect(page).not.toMatch(/this\.scanBuffer/);
  });
});

describe('when a scan is ignored', () => {
  test('typing in a field and an open modal both suppress it', () => {
    expect(onScanKey()).toContain('if (this.typingSomewhere(e) || this.committedTaskOpen())');
  });

  // A code begun outside a field and finished inside one must not be stitched
  // together into a scan nobody made.
  test('a suppressed keystroke also clears what was half-collected', () => {
    const guard = between('if (this.typingSomewhere(e) || this.committedTaskOpen())', 'return;');
    expect(guard).toContain('scanBuffer.reset()');
  });

  // The page already had _anyModalOpen(), a flag list that asks a DIFFERENT
  // question — "is the user busy, so do not re-fetch under them" — and counts
  // the combo popovers. A popover must not block a scan. If these two ever
  // collapse into one, a scan starts being swallowed by an open dropdown.
  test('the scan guard is not the background-refresh guard', () => {
    expect(page).toContain('_anyModalOpen()');
    expect(onScanKey()).not.toContain('_anyModalOpen');
    expect(between('committedTaskOpen() {', '\n      },')).not.toContain('statusOpen');
  });

  test('typing is any editable target, not just INPUT', () => {
    const fn = between('typingSomewhere(e) {', '\n      },');
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) expect(fn).toContain(tag);
    expect(fn).toContain('isContentEditable');
  });

  // Structural detection, so a modal added later is covered without anyone
  // remembering to come back. A list of *Open flags would silently rot — and
  // would have to exclude the combo popovers, which are not modals.
  test('modals are found structurally, not by listing flags', () => {
    const fn = between('committedTaskOpen() {', '\n      },');
    expect(fn).toContain(".querySelectorAll('.fixed.inset-0')");
    expect(fn).not.toMatch(/Open\b.*\|\|/);
  });

  // offsetParent is null for a position:fixed element whether it is shown or
  // hidden, so it would report every modal closed and defeat the whole guard.
  test('visibility is tested with getClientRects, not offsetParent', () => {
    const fn = between('committedTaskOpen() {', '\n      },');
    expect(fn).toContain('getClientRects().length > 0');
    expect(fn).not.toContain('offsetParent');
  });

  // The guard is only as good as its assumption that every modal is built this
  // way. If one is ever built differently, a scan runs straight through it.
  test('the modals the guard must catch are all .fixed.inset-0', () => {
    for (const flag of [
      'redeemOpen', 'notesOpen', 'resendOpen', 'undoOpen', 'cancelOpen',
      'restoreOpen', 'deleteOpen', 'discardOpen', 'typeEditorOpen',
    ]) {
      const at = page.indexOf(`x-show="${flag}"`);
      expect(at, `${flag} is not in the page`).toBeGreaterThan(-1);
      expect(page.slice(at, at + 260), `${flag} is not a .fixed.inset-0 modal`)
        .toContain('fixed inset-0');
    }
  });

  test('the page has not grown a modal style the guard cannot see', () => {
    // A rough census. It fails loudly if the modal count moves a long way from
    // the shape this guard was written against.
    const containers = (page.match(/class="fixed inset-0/g) || []).length;
    expect(containers).toBeGreaterThanOrEqual(15);
  });
});

describe('where a scan lands', () => {
  test('a repeat of the same code within a moment is one pull, not two customers', () => {
    const fn = openScannedCode();
    expect(fn).toContain('lastScannedCode');
    expect(fn).toMatch(/now - lastScannedAt < \d+/);
  });

  test('one lookup decides the destination and feeds the detail view', () => {
    const fn = openScannedCode();
    expect((fn.match(/this\.api\(/g) || [])).toHaveLength(1);
    expect(fn).toContain("await this.openVoucher(code, 'search', voucher)");
  });

  // Yanking someone onto an error screen for a mis-scan costs them whatever
  // they were doing.
  test('a lookup that fails stays put and says so', () => {
    const fn = openScannedCode();
    const failure = fn.slice(fn.indexOf('} catch (err) {'), fn.indexOf('const outcome'));
    expect(failure).toContain("'No voucher '");
    expect(failure).toContain("'error'");
    expect(failure).toContain('return;');
    expect(failure).not.toContain('openVoucher');
  });

  test('404 is told apart from a real failure', () => {
    expect(openScannedCode()).toContain('err?.status === 404');
  });

  test('an active voucher opens the redeem form with the cursor in the amount', () => {
    const fn = openScannedCode();
    expect(fn).toContain("if (outcome.action === 'redeem')");
    expect(fn).toContain('this.openRedeem();');
    expect(fn).toContain("getElementById('redeem-amount')?.focus()");
  });

  // Pre-filling the balance would make a partial redeem the path you have to
  // notice. A redeem cannot be undone without a manager.
  test('the scan never pre-fills the amount', () => {
    expect(openScannedCode()).not.toContain('redeemAmount');
    expect(between('openRedeem() {', '\n      },')).toContain("this.redeemAmount = '';");
    expect(page).toContain('id="redeem-amount"');
  });

  test('anything else sets the banner instead', () => {
    expect(openScannedCode()).toContain('this.scanBlock = outcome;');
  });

  // The banner must not survive into a voucher opened by hand, where it would
  // explain a refusal that has nothing to do with what is on screen.
  test('every route into the detail view clears the banner first', () => {
    const fn = between('async openVoucher(code, origin, preloaded) {', '\n      },');
    expect(fn).toContain('this.scanBlock = null;');
    expect(fn.indexOf('this.scanBlock = null;')).toBeLessThan(fn.indexOf('this.detailLoading = true;'));
  });

  test('the preloaded voucher is used rather than fetched again', () => {
    const fn = between('async openVoucher(code, origin, preloaded) {', '\n      },');
    expect(fn).toContain('preloaded || await this.api(');
  });
});

// Rule 4 of ADR 0006: a voucher code goes to the redeem form however it
// arrived. Physical cards carry a printed code and no QR, so typing is the
// counter path for a whole class of vouchers.
describe('a typed code lands where a scanned one does', () => {
  const submitSearch = () => between('async submitSearch() {', '\n      },');

  test('the search form submits through submitSearch()', () => {
    expect(page).toContain('@submit.prevent="submitSearch()"');
  });

  test('a code goes to the same place a scan does, and stops there', () => {
    const fn = submitSearch();
    expect(fn).toContain('isScannableCode');

    // The return is the load-bearing half. Without it the jump navigates to the
    // detail view and search() then sets the view straight back to the list,
    // so the redeem form appears and vanishes. Asserted INSIDE the branch —
    // an indexOf comparison passes vacuously when the return is gone (-1 is
    // less than everything), which is how this escaped the first time.
    const branch = fn.slice(fn.indexOf('isScannableCode'), fn.indexOf('}', fn.indexOf('isScannableCode')));
    expect(branch).toContain('await this.openScannedCode(code);');
    expect(branch).toContain('return;');
  });

  test('anything that is not a code is still a search', () => {
    expect(submitSearch()).toContain('await this.search();');
  });

  // search() is also called on load, by the dashboard drill-downs and by the
  // background refresh. A jump inside it would fire on paths nobody asked for
  // — including a return to the search view with a code still in the box,
  // which would bounce staff straight back out of it.
  test('search() itself never jumps', () => {
    const fn = between('async search() {', '\n      },');
    expect(fn).not.toContain('openScannedCode');
    expect(fn).not.toContain('isScannableCode');
  });

  test('the load and drill-down paths still call search(), not submitSearch()', () => {
    expect(between('showActiveVouchers() {', '\n      },')).toContain('await this.search();');
    expect(page).not.toMatch(/this\.submitSearch\(\)/);
  });
});

// Not scanning as such, but it exists BECAUSE of scanning: a scan reaches this
// modal without staff having read the detail page, so the modal has to say what
// it is about to take money off.
describe('the redeem modal identifies the voucher', () => {
  const modal = () => between('<div x-show="redeemOpen"', 'x-text="redeemError"');

  test('it shows the code, the customer and the type', () => {
    const html = modal();
    expect(html).toContain('x-text="voucher?.voucher_id"');
    expect(html).toContain("voucher?.customer_name || 'No name on file'");
    expect(html).toContain('voucher?._type_name || voucher?.voucher_type_id');
  });

  // The balance was already there and is the one thing that does NOT identify
  // the voucher — two vouchers of the same type carry the same balance.
  test('the balance is still there, and is not the identity', () => {
    expect(modal()).toContain('fmtMoney(voucher?.balance)');
  });

  test('the item shows only when the type has one', () => {
    const html = modal();
    expect(html).toContain('<template x-if="voucher?._item_name || voucher?.voucher_item_id">');
  });

  // The name is the assertion that matters. A voucher of the right type and
  // value belonging to the wrong person is what this catches, and nothing else
  // in the modal would.
  test('a nameless voucher says so rather than rendering blank', () => {
    expect(modal()).toContain("'No name on file'");
  });
});

describe('the refusal banner', () => {
  const banner = () => between('<template x-if="scanBlock && !detailLoading && voucher">', '</template>');

  test('each reason has its own colour', () => {
    const html = banner();
    for (const [reason, tone] of [
      ['expired', 'amber'],
      ['cancelled', 'rose'],
      ['no-balance', 'sky'],
      ['unknown', 'amber'],
    ]) {
      expect(html).toContain(`scanBlock.reason === '${reason}'`);
      expect(html).toMatch(new RegExp(`scanBlock\\.reason === '${reason}'[^]*?bg-${tone}-50`));
    }
  });

  // Never grey. A refusal in neutral tones reads as a caption rather than an
  // answer, and this is the thing a staff member reads out to a customer.
  test('no variant is neutral', () => {
    expect(banner()).not.toMatch(/bg-neutral-|text-neutral-/);
  });

  // The Tailwind Play CDN only generates classes it can see in the markup, so
  // a class name assembled in JavaScript renders as no styling at all.
  test('the colours are literal, not computed', () => {
    expect(banner()).not.toContain(':class');
  });

  test('it renders the reason in words, from the module', () => {
    expect(banner()).toContain('x-text="scanBlock.message"');
  });
});
