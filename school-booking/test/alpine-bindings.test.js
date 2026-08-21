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
const DIRECTIVE = /(?:^|\s)(x-(?!on:)[a-z][a-z-]*|:[a-zA-Z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

// Strings inside an expression are data, not references. Stripped so that
// `x-text="'review'"` is not read as a reference to `review`. Double quotes
// cannot appear inside a double-quoted attribute, so single and template
// quotes are the two that matter.
const withoutStrings = (expression) => expression.replace(/'[^']*'/g, "''").replace(/`[^`]*`/g, '``');

function directives(source) {
  const found = [];
  for (const [, name, doubled, singled] of source.matchAll(DIRECTIVE)) {
    // Both quote styles. A guard that reads only `x-show="…"` is one
    // apostrophe away from seeing nothing at all, which is the failure mode a
    // static check has to be built against.
    found.push({ name, expression: doubled ?? singled ?? '' });
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

  test('it reads single-quoted attributes too', () => {
    expect(offendersIn(directives("<div x-show='b.review'>x</div>"))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The other half of the guard
// ---------------------------------------------------------------------------
// The check above catches a *name* the page publishes as a function. The bug it
// was written for was `b.fix` — a function on a plain data object, which a text
// check can only see if the property name happens to collide with one of those
// names. Nothing static closes that.
//
// What closes it is the other end: every object an Alpine directive on this
// page can reach comes out of `review()`. So if nothing in a review is ever a
// function, there is nothing for a directive to invoke by accident, whatever it
// is named. That is an invariant rather than a pattern match, and it is checked
// here over the whole structure rather than one level of `blockers`.

function functionsIn(value, path = '$', seen = new WeakSet()) {
  if (typeof value === 'function') return [path];
  if (value === null || typeof value !== 'object') return [];
  if (seen.has(value)) return [];
  seen.add(value);
  return Object.entries(value).flatMap(([key, child]) =>
    functionsIn(child, `${path}.${key}`, seen));
}

describe('nothing a review returns is ever a function', () => {
  const fixture = (name) =>
    readFileSync(new URL(`../../docs/school-lists/${name}`, import.meta.url), 'utf8');

  const cases = {
    'a clean list': [fixture('fixture-2-spreadsheet.tsv'), {}, {}],
    'a vertical list': [fixture('fixture-1-vertical.txt'), {}, {}],
    'a refused list': [['Katie\tFernsby\t23/4/2010\t1/2/2024'].join('\n'), {}, {}],
    'a list with an unreadable line': [
      ['First name\tSurname\tDOB', 'Katie\tFernsby\t23/4/2010', 'and Otto too'].join('\n'), {}, {},
    ],
    'a list with rows resolved': [
      ['First name\tSurname\tDOB', 'Katie\tFernsby\t23/4/2010', 'and Otto too'].join('\n'),
      { 3: { kind: 'dismiss' } }, {},
    ],
    'a list mid-question': [
      ['Katie\tFernsby\t3/4/2010', 'Tomas\tOakhill\t7/11/2010'].join('\n'), {}, {},
    ],
  };

  for (const [name, [text, resolutions, options]] of Object.entries(cases)) {
    test(name, () => {
      const reviewed = steps.review(parser.parseStudentList(text, options), {
        declaration: steps.countDeclaration({ value: '3' }),
        resolutions,
      });
      expect(functionsIn(reviewed)).toEqual([]);
    });
  }
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

  test('every module in the page\'s import chain is version-busted, at one version', () => {
    // A stale cached copy of a gate module breaks every check on the page at
    // once and in silence — the one failure the ?v= exists to prevent.
    //
    // Walked rather than listed. #72 added three modules to this chain and one
    // of them, identity.js, arrived carrying an unversioned `./parse.js` that
    // had been harmless only because no page imported it yet. A hand-written
    // list of files to check is a list that goes stale exactly when a module
    // joins the chain — which is the moment the check matters.
    const imports = [...html.matchAll(/from '\.\/school-booking\/([\w.-]+)\?v=(\d+)'/g)];
    expect(imports.length, 'the page imports its modules with a ?v=').toBeGreaterThan(1);

    // Every page-side import at the same version, or the browser instantiates
    // two copies of a module the page has already moved on from.
    const versions = new Set(imports.map(([, , version]) => version));
    expect([...versions], 'bump every ?v= on the page together').toHaveLength(1);
    const pageVersion = [...versions][0];

    // Unversioned page imports would slip past the walk above, so they are
    // named separately rather than counted.
    expect(html, 'a page import with no ?v= is a module the bump never reaches')
      .not.toMatch(/from '\.\/school-booking\/[\w.-]+'/);

    // And the imports *inside* those modules. A specifier is a URL, so an
    // unversioned `./parse.js` inside steps.js is a second module the page's
    // bump never reaches — leaving the file that holds every gate running
    // against a parser the page has already moved on from.
    for (const [, file] of imports) {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      for (const [, target, version] of source.matchAll(/from '\.\/([\w.-]+)\?v=(\d+)'/g)) {
        expect(version, `bump ${target}'s ?v= in ${file} and on the page together`).toBe(pageVersion);
      }
      expect(source, `${file} imports a sibling module with no ?v=`)
        .not.toMatch(/from '\.\/[\w.-]+\.js'/);
    }
  });

  test('no two always-present outside-handlers close the same thing', () => {
    // The fault this catches, found in use on #106: the two date pickers each
    // had `@click.outside="closeDatePicker()"` on their own always-present
    // wrapper. Clicking the From trigger is *outside* the To wrapper, so To's
    // handler fired and shut the picker From had just opened — the picker
    // opened and closed on the same click, and nothing threw.
    //
    // Like the `x-show="b.fix"` bug above, this is invisible to a component
    // test: `toggleDatePicker` and `closeDatePicker` are both correct on their
    // own, and only their wiring is wrong. So it is checked as text.
    //
    // The rule: an outside-handler must sit on the element it hides — `x-show`
    // gives it no size when shut, and Alpine skips an outside-handler on a
    // zero-size element, so a closed control has no live handler to fire on a
    // click meant for another. The column chips already do this. A handler on
    // an always-present wrapper is only safe when it is alone in what it
    // closes.
    const handlers = [...html.matchAll(/<(\w+)((?:[^>]|\n)*?@click\.outside="([^"]*)"(?:[^>]|\n)*?)>/g)]
      .map(([, tag, attrs, expr]) => ({
        tag,
        expr,
        conditional: attrs.includes('x-show') || attrs.includes('x-if'),
      }));
    expect(handlers.length, 'the page has outside-handlers to check').toBeGreaterThan(0);

    const unconditional = handlers.filter((h) => !h.conditional);
    for (const handler of unconditional) {
      const sharing = handlers.filter((h) => h.expr === handler.expr).length;
      expect(
        sharing,
        `\`@click.outside="${handler.expr}"\` sits on an element with no x-show/x-if and is `
        + 'not alone — each copy fires on a click inside the other, so they close each other. '
        + 'Move it onto the element the control hides, as the column chips do.',
      ).toBe(1);
    }
  });

  test('the page is not reachable from the hub yet', () => {
    // §17: the hub entry is the last step of #46, and it is what makes every
    // earlier step visible to staff. Landing it early ships a half-built tool
    // to the front desk, because `main` is production.
    const tools = readFileSync(new URL('../../tools.json', import.meta.url), 'utf8');
    expect(tools).not.toContain('school-booking');
  });
});
