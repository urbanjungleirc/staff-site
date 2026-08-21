// The static guard from #78, on the class of bug recorded in §16 and found
// during #54:
//
//     <div x-show="b.fix">…</div>     <!-- WRONG -->
//
// Alpine **invokes** a function returned by a directive expression, so this ran
// the blocker's "confirm all" fix on **every render tick** — silently
// confirming rows nobody had confirmed, with no user action and no error. The
// confirmation gate was being defeated by its own affordance, continuously.
//
// It escapes both existing test seams. It is not a logic fault, so a unit test
// of the rules cannot see it; and it is not a thrown error, so nothing at
// runtime reports it. What it *is*, is a property of the page's text — which is
// what this file reads.
//
// The rule: inside an Alpine **directive** expression, a name the page treats
// as a function must be **called**. Calling one from `@click` is fine and is
// the whole point; binding one to a directive is the fault.
//
// This is deliberately a text check rather than DOM infrastructure. The repo has
// none and none is being introduced, and the fault is visible in the text — so
// the cheap check is also the complete one for this class.
//
// Worth remembering how the original was caught at all: a screenshot showed
// `CONFIRMED` pills on two rows while the blocker above them still named those
// exact rows as needing confirmation. **Neither the state model nor the
// rendered text was wrong on its own** — only the two together. Nobody gets a
// second screenshot for free, so the check is here.

import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import * as parser from '../parse.js';
import * as steps from '../steps.js';

const PAGE = new URL('../../school-booking.html', import.meta.url);
const html = readFileSync(PAGE, 'utf8');

// `x-on:` and `@` are excluded on purpose: an event handler is where a function
// is *supposed* to be called from. Everything else — x-show, x-if, x-text,
// x-html, x-model, x-init, x-effect, x-for and every `:attr` binding — is
// evaluated on render.
const DIRECTIVE = /(?:^|\s)(x-(?!on:)[a-z][a-z-]*|:[a-zA-Z][\w:-]*)\s*=\s*"([^"]*)"/g;

// Strings inside an expression are data, not references. Stripped so that
// `x-text="'review'"` is not read as a reference to `review`.
const withoutStrings = (expression) => expression.replace(/'[^']*'/g, "''").replace(/`[^`]*`/g, '``');

function directives(source) {
  const found = [];
  for (const [, name, expression] of source.matchAll(DIRECTIVE)) {
    found.push({ name, expression });
  }
  return found;
}

// The names the page itself publishes as functions: every function-valued
// export of the two modules, plus every method on the Alpine component. The
// component's methods are the ones that matter most — they are what a directive
// in this file can actually reach.
function componentMethods(source) {
  const script = source.slice(source.indexOf('function schoolBooking()'));
  return [...script.matchAll(/^ {4}(?:async )?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)]
    .map(([, name]) => name);
}

const moduleFunctions = [...Object.entries(parser), ...Object.entries(steps)]
  .filter(([, value]) => typeof value === 'function')
  .map(([name]) => name);

const methods = componentMethods(html);
const functionNames = [...new Set([...moduleFunctions, ...methods])];

const bound = directives(html);

describe('the guard can see what it is guarding', () => {
  // A guard that matches nothing passes forever and protects nothing. These
  // three are the ones that would silently empty it: renamed directives, a
  // reindented component, a page that stopped importing the modules.
  test('it found the page, its directives and its functions', () => {
    expect(bound.length).toBeGreaterThan(40);
    expect(methods.length).toBeGreaterThan(20);
    expect(moduleFunctions).toContain('parseStudentList');
    expect(moduleFunctions).toContain('review');
  });

  test('it recognises the bug it exists for', () => {
    const offenders = offendersIn(directives('<div x-show="b.review">x</div>'));
    expect(offenders).toHaveLength(1);
    expect(offenders[0].name).toBe('review');
  });

  test('it does not object to the same name called from a handler', () => {
    expect(offendersIn(directives('<div @click="b.review()">x</div>'))).toHaveLength(0);
    expect(offendersIn(directives('<div x-show="b.review()">x</div>'))).toHaveLength(0);
  });
});

function offendersIn(list) {
  const offenders = [];
  for (const { name: directive, expression } of list) {
    const text = withoutStrings(expression);
    for (const name of functionNames) {
      // Matches `review` and `b.review` alike — the `.` is not a word
      // character, so the lookbehind lets a property access through while
      // `prereview` and `reviewed` are excluded.
      const bare = new RegExp(`(?<![\\w$])${name}\\b(?!\\s*\\()`);
      if (bare.test(text)) offenders.push({ directive, expression, name });
    }
  }
  return offenders;
}

describe('school-booking.html', () => {
  test('no Alpine directive binds to a function without calling it', () => {
    const offenders = offendersIn(bound);
    // The failure message has to name the fix, because the next person to see
    // it will be looking at markup that renders perfectly.
    const detail = offenders
      .map((o) => `  ${o.directive}="${o.expression}"  → "${o.name}" is a function; call it, or move it to @click`)
      .join('\n');
    expect(offenders, `\n${detail}\n`).toHaveLength(0);
  });

  test('the two gate modules are imported with a cache-busting version', () => {
    // A stale cached copy of a gate module breaks every check on the page at
    // once and in silence — the one failure the ?v= exists to prevent.
    expect(html).toMatch(/import \* as parser from '\.\/school-booking\/parse\.js\?v=\d+'/);
    expect(html).toMatch(/import \* as steps from '\.\/school-booking\/steps\.js\?v=\d+'/);
  });

  test('the page is not reachable from the hub yet', () => {
    // §17: the hub entry is the last step of #46, and it is what makes every
    // earlier step visible to staff. Landing it early ships a half-built tool
    // to the front desk, because `main` is production.
    const tools = readFileSync(new URL('../../tools.json', import.meta.url), 'utf8');
    expect(tools).not.toContain('school-booking');
  });
});
