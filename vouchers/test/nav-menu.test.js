import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SECONDARY_MENU, activeMenuItem } from '../nav-menu.js';

// The nav itself is markup inside index.html's Alpine component, where no unit
// test can call it, so it is pinned against the page source the same way the
// signed-in footer is.
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

const nav = () => between('<nav', '</nav>');
const menuPanel = () => between('<!-- Hamburger panel', '<!-- /Hamburger panel');
// Everything in the nav that is not inside the panel: what staff see without
// opening anything.
const navOutsideMenu = () => nav().replace(menuPanel(), '');
// One entry per row of the open menu, in document order: the markup of the <a>
// or <button>, and the text staff actually read on it.
function menuRows() {
  return menuPanel().split(/(?=<(?:a|button) )/).slice(1).map(chunk => {
    // Cut at the row's own closing tag: what follows it belongs to the group
    // heading or to the next row, not to this one's label.
    const markup = chunk.slice(0, chunk.search(/<\/(?:a|button)>/));
    return { markup, label: markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() };
  });
}

// The hub's header nav grew a second row, one item at a time, until five
// low-emphasis items sat under the three primary actions. Everything but
// Reports now collapses behind a hamburger — at every width, so the row cannot
// re-grow the next time a feature lands. See vouchers#54.

describe('what the hamburger holds', () => {
  it('holds the four collapsed items, in the order the old row had them', () => {
    expect(SECONDARY_MENU.map(i => i.label)).toEqual([
      'Voucher Types', 'Export', 'Stats', 'Unsubscribes',
    ]);
  });

  it('does not hold Reports — that one stays pinned in the header', () => {
    expect(SECONDARY_MENU.map(i => i.label)).not.toContain('Reports');
  });

  it('separates in-page views from links that leave the page', () => {
    // Staff should not be surprised by a navigation. Stats and Unsubscribes are
    // their own pages; the other two switch the view in place.
    expect(SECONDARY_MENU.filter(i => i.kind === 'view').map(i => i.view))
      .toEqual(['voucherTypes', 'export']);
    expect(SECONDARY_MENU.filter(i => i.kind === 'page').map(i => i.href))
      .toEqual(['/vouchers/stats.html', '/vouchers/unsubscribes.html']);
  });

  it('gives every item exactly one of a view or an href', () => {
    for (const item of SECONDARY_MENU) {
      expect(Boolean(item.view) !== Boolean(item.href)).toBe(true);
    }
  });
});

describe('the header row collapses', () => {
  it('offers a hamburger', () => {
    expect(nav()).toMatch(/x-data|navMenuOpen/);
    expect(navOutsideMenu()).toMatch(/@click="navMenuOpen = !navMenuOpen"/);
  });

  it('keeps Reports in the header, out of the menu', () => {
    expect(navOutsideMenu()).toMatch(/Reports/);
    expect(menuPanel()).not.toMatch(/Reports/);
  });

  it('keeps the primary actions in the header, out of the menu', () => {
    for (const label of ['Search & Redeem', 'Create', 'Scan']) {
      expect(navOutsideMenu()).toMatch(label);
      expect(menuPanel()).not.toMatch(label);
    }
  });

  it('moves every collapsed item into the menu and nowhere else', () => {
    for (const { label } of SECONDARY_MENU) {
      expect(menuPanel()).toMatch(label);
      expect(navOutsideMenu()).not.toMatch(label);
    }
  });

  it('collapses at every width, so the row cannot re-grow on desktop', () => {
    // A responsive visibility class on the menu would let the old row come back
    // at the wide end — which is the whole failure this replaces.
    expect(menuPanel()).not.toMatch(/\b(sm|md|lg|xl):(hidden|flex|block|inline-flex)\b/);
    const trigger = between('@click="navMenuOpen = !navMenuOpen"', '</button>');
    expect(trigger).not.toMatch(/\b(sm|md|lg|xl):(hidden|flex|block|inline-flex)\b/);
  });
});

describe('telling staff where they are', () => {
  // Collapsing the row hides the label of the section you are standing in. The
  // trigger has to say it instead, or the menu costs staff their bearings.
  it('names the section when the current view is one it holds', () => {
    expect(activeMenuItem('voucherTypes').label).toBe('Voucher Types');
    expect(activeMenuItem('export').label).toBe('Export');
  });

  it('names nothing for the views that stay visible in the header', () => {
    expect(activeMenuItem('search')).toBe(null);
    expect(activeMenuItem('create')).toBe(null);
    expect(activeMenuItem('reports')).toBe(null);
  });

  it('names nothing for a view it has never heard of', () => {
    expect(activeMenuItem('')).toBe(null);
    expect(activeMenuItem(undefined)).toBe(null);
    expect(activeMenuItem('somethingElse')).toBe(null);
  });

  it('never claims a separate page as the current view', () => {
    // Stats and Unsubscribes leave the hub entirely, so no value of the hub's
    // own `view` can ever be one of them — matching on id would wrongly say so.
    expect(activeMenuItem('stats')).toBe(null);
    expect(activeMenuItem('unsubscribes')).toBe(null);
  });

  it('the trigger wears that label, and falls back to More', () => {
    const trigger = between('@click="navMenuOpen = !navMenuOpen"', '</button>');
    expect(trigger).toMatch(/x-text="activeMenuLabel\(\) \|\| 'More'"/);
    // Sighted staff get the label in the button; a screen reader gets it in the
    // accessible name, which otherwise reads as a bare "More" from anywhere.
    expect(trigger).toMatch(/:aria-label="activeMenuLabel\(\)/);
  });

  it('the label the page asks for is the one the module answers', () => {
    // Guards the binding and the module drifting onto two different functions,
    // which would leave the trigger permanently reading "More".
    expect(page).toMatch(/activeMenuLabel\(\)\s*\{[\s\S]*?window\.navMenu\?\.activeMenuItem/);
    expect(page).toMatch(/import \* as navMenu from '\.\/nav-menu\.js\?v=\d+'/);
    expect(page).toMatch(/window\.navMenu = navMenu/);
  });

  it('marks the open section inside the menu too', () => {
    // The trigger says which section; the menu says which row — without it the
    // open menu gives no clue where you already are.
    for (const item of SECONDARY_MENU.filter(i => i.kind === 'view')) {
      expect(menuPanel()).toMatch(new RegExp(`:class="view==='${item.view}' && 'active'"`));
      expect(menuPanel()).toMatch(new RegExp(`:aria-current="view==='${item.view}' \\? 'true' : false"`));
    }
  });
});

describe('the menu behaves like the hub\'s other dropdowns', () => {
  it('closes on a click outside and on Escape', () => {
    const shell = between('<div class="nav-menu"', '<!-- Hamburger panel');
    expect(shell).toMatch(/@click\.outside="navMenuOpen = false"/);
    expect(shell).toMatch(/@keydown\.escape\.window="navMenuOpen = false"/);
  });

  it('announces itself as a menu button', () => {
    const trigger = between('@click="navMenuOpen = !navMenuOpen"', '</button>');
    expect(trigger).toMatch(/aria-haspopup="true"/);
    expect(trigger).toMatch(/:aria-expanded="navMenuOpen \? 'true' : 'false'"/);
  });

  it('starts closed', () => {
    expect(page).toMatch(/navMenuOpen: false,/);
    expect(menuPanel()).toMatch(/x-show="navMenuOpen"/);
  });

  it('closes once something in it has been chosen', () => {
    // Four items, two of which switch the view in place: leaving the panel open
    // over the view it just opened is the obvious way to get this wrong.
    expect(menuPanel()).toMatch(/@click="navMenuOpen = false"/);
  });
});

describe('leaving the hub is visible before the click', () => {
  it('groups the separate pages under their own heading', () => {
    const heading = menuPanel().indexOf('nav-menu-heading');
    expect(heading).toBeGreaterThan(-1);
    // Everything after the heading leaves; everything before it stays.
    for (const item of SECONDARY_MENU) {
      const at = menuPanel().indexOf(item.label);
      if (item.kind === 'page') expect(at).toBeGreaterThan(heading);
      else expect(at).toBeLessThan(heading);
    }
  });

  it('marks each of them with an away arrow, and the in-page views with none', () => {
    for (const item of SECONDARY_MENU) {
      const row = menuRows().find(r => r.label === item.label);
      expect(row, `no row for ${item.label}`).toBeTruthy();
      expect(row.markup.includes('nav-menu-away')).toBe(item.kind === 'page');
    }
  });

  it('sends each of them to the href the module records', () => {
    for (const item of SECONDARY_MENU.filter(i => i.kind === 'page')) {
      expect(menuPanel()).toMatch(`href="${item.href}"`);
    }
  });

  it('opens the in-page views through the hub\'s own handlers', () => {
    expect(menuPanel()).toMatch(/@click="goVoucherTypes\(\)"/);
    expect(menuPanel()).toMatch(/@click="goExport\(\)"/);
    expect(menuPanel()).not.toMatch(/href="\/vouchers\/index\.html/);
  });
});

describe('the menu and the page agree on what is in it', () => {
  it('lists exactly the module\'s items, in the module\'s order', () => {
    // The rows are written out in the markup, icons and all, rather than looped
    // from the module — so this is what stops the two drifting apart.
    expect(menuRows().map(r => r.label)).toEqual(SECONDARY_MENU.map(i => i.label));
  });
});

describe('the Reports view is named the way the nav names it', () => {
  // The nav said "Reports" while the view id and its handler said "report".
  // Same thing, two spellings, and the reader has to know they are the same.
  it('has no singular report view or handler left', () => {
    expect(page).not.toMatch(/view\s*===?\s*'report'/);
    expect(page).not.toMatch(/view\s*=\s*'report'/);
    expect(page).not.toMatch(/view==='report'/);
    expect(page).not.toMatch(/\bgoReport\b(?!s)/);
  });

  it('pins the plural view to the pinned nav button', () => {
    expect(navOutsideMenu()).toMatch(/@click="goReports\(\)"/);
    expect(navOutsideMenu()).toMatch(/view==='reports'/);
    expect(page).toMatch(/async goReports\(\)\s*\{/);
    expect(page).toMatch(/<div x-show="view==='reports'">/);
  });

  it('still calls the report it loads a report', () => {
    // The plural is the section; the thing the API returns is one report, and
    // renaming that too would be a rename for its own sake.
    expect(page).toMatch(/async loadReport\(\)/);
    expect(page).toMatch(/this\.report = await this\.api/);
  });
});
