import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';

// Staff share the counter machines, so "who am I signed in as" is a question the
// page has to answer without being asked. The answer lives in a footer, and the
// footer is markup inside index.html's Alpine component where no unit test can
// call it — so it is pinned against the page source, the same way the created-by
// attribution rules are. See vouchers#56.
//
// Two things here are load-bearing rather than cosmetic:
//
//   1. The email must be *bound*, not merely fetched. The identity call and the
//      accessEmail field already existed and were dead — the value was assigned
//      and never rendered. A test that only checked the fetch would have passed
//      against the broken page.
//   2. An absent email must render nothing at all. Local development signs in by
//      shared secret and carries no Access identity, so a dangling "Signed in as"
//      with a blank after it is a reachable state, not a hypothetical one.

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

const footer = () => between('<footer', '</footer>');

describe('the hub has a footer', () => {
  test('a footer element exists', () => {
    expect(page).toMatch(/<footer[\s>]/);
  });

  test('its two items sit at opposite ends of the line', () => {
    // Who you are on the left, which build you are on at the right. They answer
    // unrelated questions and reading them as one run-on phrase helps nobody.
    expect(footer()).toMatch(/justify-between/);
  });

  test('the footer is in document flow after the main content', () => {
    // The modals and the toast are fixed overlays and are not in flow, so the
    // footer has nothing to displace — but only if it is not fixed itself. A
    // footer pinned to the viewport would cover the content it sits under.
    expect(page.indexOf('<footer')).toBeGreaterThan(page.indexOf('</main>'));
    expect(footer()).not.toMatch(/\bfixed\b/);
  });
});

describe('the signed-in email is shown', () => {
  test('the footer binds the Access email rather than leaving it unused', () => {
    expect(footer()).toMatch(/x-text="accessEmail"/);
  });

  test('the value bound is the one the identity call writes', () => {
    // Guards against the binding and the fetch drifting onto two different
    // fields, which would leave the footer permanently empty.
    expect(between('get-identity', 'catch')).toMatch(/this\.accessEmail = /);
  });

  test('the label reads "Signed in as"', () => {
    expect(footer()).toMatch(/Signed in as/i);
  });
});

describe('an absent identity degrades quietly', () => {
  test('the whole line is hidden when there is no email', () => {
    // x-show has to sit on an element wrapping the label, not on the email span
    // alone: hiding the value but keeping the words leaves "Signed in as" with
    // nothing after it, which is the state this is meant to prevent.
    const line = between('Signed in as', '</span>');
    const wrapper = footer().slice(0, footer().indexOf('Signed in as'));
    expect(wrapper).toMatch(/x-show="accessEmail"/);
    expect(line).not.toMatch(/x-show/);
  });
});

// The build version shares this footer, and shares reason (1) above: the
// formatting is unit tested in version-display.test.js, but formatting a string
// nothing renders would pass just as well. See vouchers#58.
describe('the build version is shown beside the identity', () => {
  test('the footer binds the formatted version', () => {
    expect(footer()).toMatch(/x-text="buildVersion"/);
  });

  test('the value bound is the one the version fetch writes', () => {
    // Same drift guard as the email: a binding and a loader on two different
    // fields leaves the footer permanently empty and nothing else complains.
    expect(between('async loadBuildVersion', '\n      },')).toMatch(/this\.buildVersion = /);
  });

  test('the loader actually runs on init', () => {
    // Defining loadBuildVersion() and never calling it is the exact shape of
    // the dead identity call this file was written for.
    expect(page).toMatch(/this\.loadBuildVersion\(\);/);
  });

  test('the version is fetched with no-store', () => {
    // Load-bearing, not a precaution: version.json sits on the same static
    // origin as this HTML, so a cached copy would name the previous build as
    // the current one — announcing the page is fresh at the moment it is
    // stale. Nothing else in the system would catch that, which is why it is
    // pinned here. See vouchers#58 and ADR 0004.
    const loader = between('async loadBuildVersion', '\n      },');
    expect(loader).toMatch(/fetch\('\.\/version\.json',\s*\{\s*cache:\s*'no-store'\s*\}\)/);
  });
});

describe('an absent build version degrades quietly', () => {
  test('the line is hidden rather than rendered empty', () => {
    // version.json is absent in local development and after any failed deploy,
    // so an empty slot or a bare "v" is a reachable state, not a hypothetical.
    const versionSpan = between('x-show="buildVersion"', '</span>');
    expect(versionSpan).toMatch(/x-text="buildVersion"/);
  });

  test('the version starts empty so nothing flashes before the fetch lands', () => {
    expect(page).toMatch(/buildVersion: '',/);
  });
});
