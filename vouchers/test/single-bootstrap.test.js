import { describe, expect, test } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Alpine calls a component's own init() for us. A page that names it in x-init
// as well runs its whole bootstrap a second time: every opening fetch twice,
// every listener registered twice, every interval installed twice — and the
// handle to the first one overwritten, so it can never be cleared.
//
// The defect is invisible unless something on the page happens to be sensitive
// to running twice. On stats.html it was: the second pass destroyed four
// Chart.js charts mid-animation and the page sat blank (vouchers#69). On the
// hub and the unsubscribes list nothing showed on screen at all — measured, the
// hub opened with two of every request instead of one (vouchers#70).
//
// This file therefore sweeps EVERY page on the site, not the voucher pages. It
// lives in this suite because this suite is where the defect was found twice
// and where the tooling already is; there is no test runner at the repo root.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

function htmlFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...htmlFiles(full));
    else if (entry.name.endsWith('.html')) found.push(full);
  }
  return found;
}

// Comments are stripped first: all four Alpine pages now carry a note saying
// why they have no x-init, and the sweep would read those notes as the defect.
const withoutComments = (html) => html.replace(/<!--[\s\S]*?-->/g, '');

// Every opening tag, closing '>' included. Attribute values hold '>' on this
// site (arrow functions inside x-text and x-show), so the scan walks quoted
// runs rather than stopping at the first '>' it sees.
function openingTags(html) {
  const tags = [];
  const opens = /<[a-zA-Z][a-zA-Z0-9-]*/g;
  let open;
  while ((open = opens.exec(html)) !== null) {
    let i = opens.lastIndex;
    let quote = '';
    while (i < html.length) {
      const c = html[i];
      if (quote) { if (c === quote) quote = ''; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
      i += 1;
    }
    tags.push(html.slice(open.index, i + 1));
  }
  return tags;
}

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`));
  return m ? (m[1] ?? m[2]) : null;
};

// `init(` as a call, not `myInit(` and not `this.init(` — the second is a
// deliberate re-run from inside the component, which is not what this pins.
const CALLS_INIT = /(?:^|[^\w.$])init\s*\(/;

// Any x-init, not only one sharing a tag with x-data: an x-init on a child
// element evaluates in the nearest component scope, so `init()` there is the
// same method and doubles the same bootstrap.
const offendingTags = (html) => openingTags(withoutComments(html))
  .filter((tag) => {
    const init = attr(tag, 'x-init');
    return init !== null && CALLS_INIT.test(init);
  });

const componentTags = (html) => openingTags(withoutComments(html))
  .filter((tag) => attr(tag, 'x-data') !== null);

const pages = htmlFiles(ROOT).map((file) => {
  const name = relative(ROOT, file).split(sep).join('/');
  return { name, html: readFileSync(file, 'utf8') };
});

// Pages carrying an Alpine component, paired with the factory that builds it.
// Derived rather than listed, so a page added later is swept without an edit
// here — the whole point of vouchers#70's "cover every page on the site".
const alpinePages = pages
  .map(({ name, html }) => ({ name, html, factory: (html.match(/x-data="(\w+)\(\)"/) || [])[1] }))
  .filter((page) => page.factory);

describe('the sweep can see the defect it is pinning', () => {
  // Without these, the sweep below passes by finding nothing: once every
  // x-init is gone from the repo, its filter matches no tag and its
  // expectations never run. A matcher no test exercises is not a pin.
  test('it catches the pairing this bug was', () => {
    expect(offendingTags('<body x-data="staffApp()" x-init="init()" x-cloak>')).toHaveLength(1);
  });

  test('it catches an x-init on a child of the component', () => {
    expect(offendingTags('<div x-data="app()"><span x-init="init()"></span></div>')).toHaveLength(1);
  });

  test('it reads past a > inside an attribute value', () => {
    // school-booking.html and the hub both carry arrow functions in bindings.
    const html = '<div x-show="rows.some((r) => r.bad)" x-init="init()"></div>';
    expect(offendingTags(html)).toHaveLength(1);
  });

  test('it leaves an x-init that calls something else alone', () => {
    expect(offendingTags('<div x-data="app()" x-init="$watch(\'q\', load)"></div>')).toHaveLength(0);
    expect(offendingTags('<div x-data="app()" x-init="reinit()"></div>')).toHaveLength(0);
    expect(offendingTags('<div x-data="app()" x-init="this.init()"></div>')).toHaveLength(0);
  });

  test('it does not read a comment about x-init as an x-init', () => {
    expect(offendingTags('<!-- No x-init="init()" here -->\n<body x-data="app()">')).toHaveLength(0);
  });
});

describe('every page on the site bootstraps exactly once', () => {
  test('the sweep sees the pages it is meant to guard', () => {
    // A broken walk would pass every assertion below by finding nothing.
    const names = pages.map(({ name }) => name);
    expect(names).toContain('vouchers/index.html');
    expect(names).toContain('vouchers/stats.html');
    expect(names).toContain('vouchers/unsubscribes.html');
    expect(names).toContain('school-booking.html');
  });

  test('and it parses real markup, not only the fixtures above', () => {
    // openingTags/attr working on a hand-written string is no evidence they
    // work on a 5,000-line page with arrow functions inside its bindings.
    for (const { name, html } of alpinePages) {
      expect(componentTags(html), `${name} has a readable x-data tag`).not.toHaveLength(0);
    }
  });

  test.each(pages.map(({ name, html }) => [name, html]))(
    '%s does not call init() from x-init as well',
    (_name, html) => {
      expect(offendingTags(html)).toEqual([]);
    },
  );
});

describe('the components Alpine bootstraps still define init()', () => {
  // The other half of the pair. Dropping x-init is only safe while the method
  // is still called init(); rename it and the page stops bootstrapping at all,
  // with nothing on screen to say so. Every Alpine page on this site has a
  // bootstrap, so this holds for all of them and is derived, not listed.
  test.each(alpinePages.map(({ name, factory }) => [name, factory]))(
    '%s: %s() defines an init()',
    (name) => {
      const { html } = alpinePages.find((page) => page.name === name);
      // async or not: school-booking's is synchronous, the voucher pages' are not.
      // Exactly one, so a rename cannot be covered for by an unrelated init()
      // elsewhere in the page — the match is not tied to the factory's body.
      const defined = html.match(/\n\s+(?:async )?init\(\) \{/g) || [];
      expect(defined).toHaveLength(1);
    },
  );
});
