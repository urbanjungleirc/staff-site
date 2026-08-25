import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';

// After a successful create the page used to leave the form and its "Create
// voucher" button fully live, with the confirmation rendered above them and the
// page not scrolled — so what staff were looking at was a filled form and a
// live button. Several duplicate vouchers came out of it (#133).
//
// These read the page source. Be clear about what that proves: they assert the
// markup SAYS the form is gated and the buttons go where they should, not that
// a browser hides anything. What they catch is the gate being dropped, a new
// panel being added outside it, or Done being re-pointed at the view directly.

const page = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

const GATE = 'x-show="!createdVoucher"';

// The create view, from its own gate to the start of the next one.
function createView() {
  const start = page.indexOf(`<div x-show="view==='create'">`);
  if (start < 0) throw new Error('could not find the create view in index.html');
  const end = page.indexOf('<!-- ── Reports ─', start);
  if (end < 0) throw new Error('could not find the end of the create view');
  return page.slice(start, end);
}

// Everything from the gate to the end of the create view. If the gate is
// dropped this throws, which is the point.
function gatedRegion() {
  const view = createView();
  const at = view.indexOf(GATE);
  if (at < 0) throw new Error(`the create form is not gated on ${GATE}`);
  return view.slice(at);
}

describe('a finished create takes the form off the page', () => {
  test('the form is gated on there being no created voucher', () => {
    expect(createView()).toContain(GATE);
  });

  // The button is the thing that got pressed twice. Gating the fields but
  // leaving it would be the same bug with fewer steps.
  test('the submit button is inside the gate', () => {
    expect(gatedRegion()).toContain('submitCreate()');
  });

  test('the whole form is inside the gate, not just the first panel', () => {
    const gated = gatedRegion();
    for (const part of [
      'grid grid-cols-1 md:grid-cols-3',   // the three-column form
      'x-model="createIssuer"',            // Created by
      'x-model="createGiftMessage"',       // the last field of the last panel
      'Conditions &amp; expiry',           // the type's staff-facing note
      'openCreatePreview()',               // Preview email, beside submit
    ]) expect(gated).toContain(part);
  });

  // One wrapper rather than a gate per panel: a block added to the form later
  // is then gated by where it sits, instead of by someone remembering.
  test('the form sits under a single gate, not several', () => {
    expect(createView().split(GATE)).toHaveLength(2);
  });

  test('the heading stops saying "Create Voucher" once one exists', () => {
    expect(createView()).toMatch(
      /x-text="createdVoucher \? 'Voucher created' : 'Create Voucher'"/,
    );
  });
});

describe('the result panel says what to do next', () => {
  // The result is rendered above the gate, so anything the confirmation needs
  // must live outside the gated region.
  function resultPanel() {
    const view = createView();
    return view.slice(0, view.indexOf(GATE));
  }

  test('Done goes through goSearch(), which refreshes the stale list', () => {
    // Not `view = 'search'`: _searchStale is set on create and only goSearch()
    // acts on it, so a direct assignment lands staff on a list that does not
    // contain the voucher they just made. search-freshness.test.js pins the
    // same rule from the other side.
    expect(resultPanel()).toContain(`@click="goSearch()"`);
    expect(resultPanel()).not.toMatch(/@click="[^"]*view\s*=\s*'search'/);
  });

  test('Create another goes through goCreate(), so nothing carries over', () => {
    // goCreate() resets every field. Reusing the previous voucher's type and
    // value would let a stale amount attach to the next customer silently.
    expect(resultPanel()).toContain(`@click="goCreate()"`);
  });

  test('the details link still points at the voucher just created', () => {
    expect(resultPanel()).toContain(`openVoucher(createdVoucher.voucher_id, 'search')`);
  });

  test('Done is the solid button and Create another is not', () => {
    // The counter workflow is one and out, and a solid button in this position
    // that creates a voucher is what was re-pressed.
    const done = resultPanel().slice(resultPanel().indexOf(`@click="goSearch()"`));
    const another = resultPanel().slice(resultPanel().indexOf(`@click="goCreate()"`));
    expect(done.slice(0, 200)).toMatch(/bg-uj\b/);
    expect(another.slice(0, 200)).not.toMatch(/bg-uj\b/);
  });
});

describe('the confirmation is put in front of whoever pressed the button', () => {
  function submitCreate() {
    const start = page.indexOf('async submitCreate()');
    return page.slice(start, page.indexOf('async goReports()', start));
  }

  test('a successful create scrolls back to the result', () => {
    // The page is scrolled to wherever the submit button was. This is the
    // original fault: the confirmation rendered above the viewport.
    expect(submitCreate()).toMatch(/window\.scrollTo\(\{\s*top: 0/);
  });

  test('no toast competes with the result screen', () => {
    // The toast was the only signal in view, which is what taught staff to read
    // a success as "something happened, but the form is still here".
    expect(submitCreate()).not.toMatch(/showToast\([^)]*created/);
  });

  test('the search list is still marked stale by a create', () => {
    expect(submitCreate()).toMatch(/this\._searchStale = true;/);
  });
});
