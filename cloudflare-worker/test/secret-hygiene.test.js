import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Repo-wide secret hygiene, not Worker behaviour — it lives in this harness
// because it is the only vitest setup in the repo, and `npm test` here is the
// one command CI already runs.
//
// staff-site is a PUBLIC repo (urbanjungleirc/staff-site). A Worker secret that
// reaches a commit here is world-readable and, once pushed, permanently in
// history. Each Worker directory carrying its own .gitignore is not enough:
// the next Worker directory starts without one, which is exactly how a key
// gets committed. These tests assert the repo-level rule instead.

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const git = (...args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' });

/**
 * git grep exits 1 for "no matches" and 2+ for a real failure (bad regex, not a
 * repo). Collapsing those makes a broken search look like a clean repo, so only
 * status 1 is treated as an empty result and anything else rethrows.
 */
const gitGrep = (pattern) => {
  try {
    return git('grep', '-InE', pattern, '--', '.').split('\n').filter(Boolean);
  } catch (err) {
    if (err.status === 1) return [];
    throw err;
  }
};

/** git check-ignore exits 1 when the path is NOT ignored, which is not a throw we want. */
const isIgnored = (relPath) => {
  try {
    git('check-ignore', '-q', relPath);
    return true;
  } catch {
    return false;
  }
};

describe('secret hygiene in a public repo', () => {
  it('ignores .dev.vars in every Worker directory, including ones not yet created', () => {
    const dirs = [
      'cloudflare-worker',
      'cloudflare-payments-proxy',
      'cloudflare-clubworx',
      // A directory nobody has thought of yet. The rule has to cover it too,
      // or this test only ever documents the past.
      'cloudflare-some-future-worker',
    ];

    const notIgnored = dirs.filter((d) => !isIgnored(`${d}/.dev.vars`));

    expect(notIgnored).toEqual([]);
  });

  it('ignores a bare .dev.vars at the repo root', () => {
    expect(isIgnored('.dev.vars')).toBe(true);
  });

  it('tracks no .dev.vars file anywhere in the repo', () => {
    const tracked = git('ls-files').split('\n').filter((f) => path.basename(f) === '.dev.vars');

    expect(tracked).toEqual([]);
  });

  it('tracks no file holding a literal clubworx account_key value', () => {
    // The Worker builds its upstream URL as account_key=<secret>. A committed
    // file with a non-placeholder value on that parameter is a leaked key.
    //
    // git grep -E is POSIX ERE and has no lookahead, so the placeholders are
    // filtered here rather than in the pattern. Doing it in the pattern made
    // git exit 2 on an invalid regex, which a bare catch then read as "clean" —
    // a test that could not fail.
    const PLACEHOLDER = /^(your-unique-digital-key|unique-|<|\$|\{)/;

    const hits = gitGrep('account_key=[A-Za-z0-9_-]{8,}')
      .filter((line) => {
        const value = line.match(/account_key=([A-Za-z0-9_-]{8,})/)?.[1] ?? '';
        return !PLACEHOLDER.test(value);
      })
      // The API reference is a documentation file of example URLs, not config.
      .filter((line) => !line.startsWith('docs/'));

    expect(hits).toEqual([]);
  });
});
