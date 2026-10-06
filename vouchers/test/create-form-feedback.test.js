import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';

// The create form is taller than the screen, so the submit button sits below the
// fold while the error banner sits above the form. An error set in place was
// invisible at the moment it mattered. These pin the page source (the logic is
// inline in index.html's Alpine component) so the scroll cannot be dropped.
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const submit = html.slice(html.indexOf('async submitCreate()'), html.indexOf('// ── Header nav'));

describe('create voucher form feedback', () => {
  test('every validation and server error in submitCreate scrolls the banner into view', () => {
    expect(submit).toContain('this.failCreate(');
    expect(submit).not.toMatch(/this\.createError = (?!'')/);
  });

  test('failCreate scrolls to the banner', () => {
    expect(html).toMatch(/failCreate\(message\)[\s\S]{0,300}getElementById\('create-error'\)\?\.scrollIntoView/);
    expect(html).toMatch(/id="create-error"/);
  });

  test('the Clubworx receipt card follows the Voucher details card, before Customer info', () => {
    const details = html.indexOf('<span class="text-xs font-semibold text-neutral-600 uppercase tracking-wider">Voucher details');
    const receipt = html.indexOf('Clubworx receipt #', details);
    const customer = html.indexOf('② Customer info');
    expect(details).toBeGreaterThan(-1);
    expect(receipt).toBeGreaterThan(details);
    expect(receipt).toBeLessThan(customer);
  });
});
