import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';

// Landing on the search view must not show a list that predates the voucher you
// just issued. The wiring lives inline in index.html's Alpine component where no
// unit test can call it, so it is pinned against the page source instead — the
// same approach as created-by-attribution.test.js.
//
// The fetch itself was never the problem: refreshData() already sends the
// filters that are in the search bar and leaves the current page alone. What
// this pins is *when* it runs. See vouchers#67.

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

describe('a create marks the search list stale', () => {
  test('the flag is raised after the POST resolves, not before it', () => {
    const submitCreate = between('async submitCreate()', '// ── Header nav');
    const posted = submitCreate.indexOf("this.createdVoucher = await this.api('/v1/vouchers'");
    const flagged = submitCreate.search(/this\._searchStale = true;/);
    expect(posted).toBeGreaterThan(-1);
    expect(flagged).toBeGreaterThan(posted);
  });

  test('the flag starts down, so a first load does not double-fetch', () => {
    expect(page).toMatch(/_searchStale: false,/);
  });
});

describe('landing on search refreshes a stale list', () => {
  test('goSearch() forces past the throttle exactly when the list is stale', () => {
    // The method definition, not the click handlers that call it.
    const goSearch = between('goSearch() {', '},');
    expect(goSearch).toMatch(/this\.view = 'search';/);
    expect(goSearch).toMatch(/refreshData\(\{ force: this\._searchStale \}\)/);
  });

  test('it refreshes rather than re-running the search', () => {
    // search() resets the pagination and re-reads the filter inputs; refreshData
    // deliberately does neither. Landing on the view must not throw away the
    // page the user was on.
    expect(between('goSearch() {', '},')).not.toMatch(/this\.search\(/);
  });

  test('the throttle is bypassed only when forced', () => {
    const refreshData = between('async refreshData(', '// ── Sort & pagination');
    expect(refreshData).toMatch(/async refreshData\(\{ force = false \} = \{\}\)/);
    expect(refreshData).toMatch(/if \(!force && Date\.now\(\) - this\._lastRefresh < 60 \* 1000\) return;/);
  });

  test('the flag comes down only after a search fetch that actually succeeded', () => {
    const refreshData = between('async refreshData(', '// ── Sort & pagination');
    const fetched = refreshData.indexOf("this.results = await this.api('/v1/vouchers/search?'");
    const cleared = refreshData.search(/this\._searchStale = false;/);
    expect(fetched).toBeGreaterThan(-1);
    // After the await: a refresh that threw leaves the flag up so the next
    // landing tries again, rather than settling on a list it never replaced.
    expect(cleared).toBeGreaterThan(fetched);
  });
});

describe('every route into the search view goes through goSearch()', () => {
  test('no click handler sets the view directly', () => {
    // A future button that assigns view='search' itself would skip the refresh
    // and reopen this bug on one path while the others stayed fixed.
    const direct = [...page.matchAll(/@click="([^"]*\bview\s*=\s*['"]search['"][^"]*)"/g)].map((m) => m[1]);
    expect(direct).toEqual([]);
  });

  // The scan view used to be the second route in here. It was deleted in #136:
  // it had no caller anywhere in the repo, so it was unreachable dead code, and
  // scanning is now a global keystroke listener with no screen of its own (ADR
  // 0006). The nav button is the only route left.
  test('the header nav calls it', () => {
    const navButton = between('<nav class="flex flex-col gap-1.5 sm:items-end">', 'goCreate()');
    expect(navButton).toMatch(/@click="goSearch\(\)/);
  });

  test('leaving the detail view returns through one shared path', () => {
    // The back button and the post-delete return both land on whichever list
    // opened the detail view; sharing the method keeps them from drifting.
    expect(between("<div x-show=\"view==='detail'\">", '</button>')).toMatch(/@click="backFromDetail\(\)"/);
    expect(between('async submitDelete()', 'catch (e)')).toMatch(/this\.backFromDetail\(\);/);
    const backFromDetail = between('backFromDetail() {', '},');
    expect(backFromDetail).toMatch(/this\.view = 'reports';/);
    expect(backFromDetail).toMatch(/this\.goSearch\(\);/);
  });
});
