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

  test('the line does not flash before Alpine initialises', () => {
    // x-show is applied by Alpine, which loads after the markup is painted. The
    // page already relies on [x-cloak] elsewhere for exactly this reason.
    expect(footer()).toMatch(/x-cloak/);
    expect(page).toMatch(/\[x-cloak\] \{ display: none !important; \}/);
  });
});
