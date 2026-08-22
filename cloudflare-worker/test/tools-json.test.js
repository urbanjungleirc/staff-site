import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The hub's own invariants, not this Worker's behaviour.
//
// `tools.json` is the source of truth for every card on ujstaff.happyk.au, and
// CLAUDE.md's Safety Notes carry the rule this file enforces: "tools.json is
// user-facing through the hub, so validate links after editing it." A hub entry
// pointing at nothing is a 404 on the front desk, and index.html renders it
// exactly as confidently as a working one — there is no broken-link state, so
// nothing on the page says which card is dead.
//
// It sits in cloudflare-worker/ for the same two reasons secret-hygiene.test.js
// does, and they are worth repeating rather than looked up:
//
//   - There is no repo-level vitest harness, so any home is somebody's
//     subdirectory. This Worker is the least arbitrary one: it owns
//     `/api/tools.json` and the `validateToolsJson` schema check behind it, so
//     the file's shape is already this package's business.
//   - Nothing runs it automatically. pages.yml — the repo's only workflow —
//     runs no tests at all, so this guard fires only when someone runs vitest
//     by hand. Wiring tests into CI is staff-site#47's open recommendation.

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOOLS = path.join(REPO, 'tools.json');
const readTools = () => JSON.parse(readFileSync(TOOLS, 'utf8'));

/**
 * Is this path served out of this repo, rather than off somewhere else?
 *
 * Anything carrying a scheme (`https:`, `mailto:`) or a protocol-relative
 * `//host/x` names another origin and is nobody's file here. Everything else is
 * ours — including a root-relative `/sls.html`, which the hub resolves against
 * the site root, and the site root is this directory.
 */
const isLocal = (p) => typeof p === 'string' && p !== '' && !/^[a-z][a-z0-9+.-]*:/i.test(p) && !p.startsWith('//');

/**
 * The file a local path names. A `?query` or `#hash` addresses something inside
 * the page and never a second file, so both are dropped before the disk is
 * asked — left on, they turn a working link into a failure with no fault in it.
 */
const toRepoPath = (p) => p.replace(/[?#].*$/, '').replace(/^\/+/, '');

describe('tools.json', () => {
  it('is valid JSON with an entries array', () => {
    const tools = readTools();
    expect(Array.isArray(tools.entries)).toBe(true);
  });

  it('backs every local path with a real file or directory', () => {
    // Both entry shapes carry paths: a `type: "tool"` has one of its own, and a
    // `type: "group"` has none but holds an `items` array of them. Checking only
    // the top level would pass every group vacuously — which is where most of
    // the paths in this file actually live.
    const tools = readTools();
    const paths = tools.entries.flatMap((e) => [e.path, ...(e.items ?? []).map((i) => i.path)]);

    expect(paths.filter(isLocal).length, 'there are local paths to check').toBeGreaterThan(0);
    for (const entryPath of paths.filter(isLocal)) {
      expect(
        existsSync(path.join(REPO, toRepoPath(entryPath))),
        `tools.json points at \`${entryPath}\`, which is not in this repo`,
      ).toBe(true);
    }
  });
});
