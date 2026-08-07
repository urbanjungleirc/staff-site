import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';

// The front desk machine is shared. Two rules protect attribution on it, and
// both live inline in index.html's Alpine component where no unit test can
// call them — so they are pinned against the page source instead.
//
//   1. The typed "Created by" name is never persisted or restored. Anything
//      that survives a reload belongs to whoever was last at the counter.
//   2. Cancel, restore and delete never borrow that name. Those actions show
//      no name field at all, so a wrong value there is invisible — worse than
//      the create form, where at least it is on screen to be corrected.
//
// The verified audit actor is unaffected either way: the Worker derives it from
// the Access JWT, not from anything the browser sends. See vouchers#59.

const page = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

// Slicing on an anchor that has moved yields a one-character string and a
// failure that reads as a fault in the page rather than in this file.
function between(startAnchor, endAnchor) {
  const start = page.indexOf(startAnchor);
  if (start < 0) throw new Error('could not find ' + startAnchor + ' in index.html');
  const end = page.indexOf(endAnchor, start);
  if (end < 0) throw new Error('could not find ' + endAnchor + ' after ' + startAnchor);
  return page.slice(start, end);
}

describe('created-by is not remembered across staff', () => {
  test('the page never reads or writes the remembered-name key, except to purge it', () => {
    // Match on the method alone, not the whole call: setItem takes a second
    // argument, so a pattern ending in `)` would silently miss every write —
    // which is the regression this test exists to catch. Either quote style,
    // for the same reason: the net has to hold whatever a future edit writes.
    const methods = [...page.matchAll(/localStorage\.(\w+)\(\s*['"]uj_voucher_created_by['"]/g)].map((m) => m[1]);
    expect(methods).toEqual(['removeItem']);
  });

  test('opening the create form clears the name along with the customer fields', () => {
    expect(between('async goCreate()', 'async submitCreate()')).toMatch(/this\.createIssuer = '';/);
  });

  test('the browser is not asked to remember the name either', () => {
    // Same reason the manager password and typed delete code carry this.
    const field = between('x-model="createIssuer"', '/>');
    expect(field).toMatch(/autocomplete="off"/);
  });

  test('a successful create clears the name so the next voucher is attributed afresh', () => {
    const submitCreate = between('async submitCreate()', 'async goReports()');
    // After the POST, not before it — the value still has to reach the request.
    const posted = submitCreate.indexOf('issued_by: this.createIssuer.trim()');
    const cleared = submitCreate.indexOf("this.createIssuer = '';");
    expect(posted).toBeGreaterThan(-1);
    expect(cleared).toBeGreaterThan(posted);
  });
});

describe('lifecycle actions do not borrow the create-form name', () => {
  test.each(['restored_by', 'cancelled_by', 'deleted_by'])('%s is sent unattributed', (field) => {
    const line = page.split('\n').find((l) => l.includes(field + ':'));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/createIssuer/);
    expect(line).toMatch(/'staff'/);
  });
});
