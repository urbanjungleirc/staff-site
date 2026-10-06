import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { receiptRequired } from '../purchase-receipt.js';

const page = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

describe('receiptRequired', () => {
  test.each([
    ['sale', true], ['promo_sale', true],
    ['credit', false], ['comp', false], ['donation', false],
  ])('%s -> %s', (cls, expected) => {
    expect(receiptRequired({ revenue_class: cls })).toBe(expected);
  });

  test('no type selected means not required', () => {
    expect(receiptRequired(null)).toBe(false);
    expect(receiptRequired(undefined)).toBe(false);
  });
});

describe('create form wiring', () => {
  test('submitCreate refuses a missing receipt and sends it as purchase_receipt', () => {
    const body = page.slice(page.indexOf('async submitCreate()'));
    expect(body).toMatch(/receiptRequired\(selectedType\)\s*&&\s*!this\.createReceipt\.trim\(\)/);
    expect(body).toMatch(/purchase_receipt:\s*this\.createReceipt\.trim\(\) \|\| null/);
  });

  test('opening the form clears the receipt', () => {
    const goCreate = page.slice(page.indexOf('async goCreate()'), page.indexOf('async submitCreate()'));
    expect(goCreate).toMatch(/this\.createReceipt = '';/);
  });

  test('the detail page labels the two receipts apart', () => {
    expect(page).toMatch(/Purchase receipt/);
    expect(page).toMatch(/Redemption receipt/);
    expect(page).not.toMatch(/>Clubworx receipt</);
  });
});
