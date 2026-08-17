import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Repo-wide secret hygiene, not this Worker's behaviour.
//
// staff-site is a PUBLIC repo (urbanjungleirc/staff-site). A Worker secret that
// reaches a commit here is world-readable and, once pushed, permanently in
// history. Each Worker directory carrying its own .gitignore is not enough:
// the next Worker directory starts without one, which is exactly how a key
// gets committed. These tests assert the repo-level rule instead.
//
// Two caveats about where this sits, both deliberate and both worth knowing:
//
//   - It is in cloudflare-worker/ for want of a repo-level harness. There are
//     three vitest packages here (cloudflare-worker, cloudflare-payments-proxy,
//     vouchers) and no root one, so any home is somebody's subdirectory.
//   - Nothing runs it automatically. pages.yml — the repo's only workflow —
//     runs no tests at all, so this guard only fires when someone runs vitest
//     by hand. It documents and checks the rule; it does not enforce it in CI.
//     Wiring it into CI is staff-site#47's open recommendation.

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const git = (...args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' });

/**
 * git grep exits 1 for "no matches" and 2+ for a real failure (bad regex, not a
 * repo). Collapsing those makes a broken search look like a clean repo, so only
 * status 1 is treated as an empty result and anything else rethrows.
 */
const gitGrep = pattern => {
  try {
    return git('grep', '-InE', pattern, '--', '.').split('\n').filter(Boolean);
  } catch (err) {
    if (err.status === 1) return [];
    throw err;
  }
};

/** git check-ignore exits 1 when the path is NOT ignored, which is not a throw we want. */
const isIgnored = relPath => {
  try {
    git('check-ignore', '-q', relPath);
    return true;
  } catch {
    return false;
  }
};

/** Every Worker directory present today, so a rename cannot silently skip one. */
const workerDirs = () =>
  git('ls-files')
    .split('\n')
    .map(f => f.split('/')[0])
    .filter(d => d.startsWith('cloudflare-'));

// Wrangler reads .dev.vars and .dev.vars.<environment>; .env is the habit people
// arrive with. All three would carry the same key, so all three must be covered.
const SECRET_FILENAMES = ['.dev.vars', '.dev.vars.production', '.dev.vars.local', '.env'];

describe('secret hygiene in a public repo', () => {
  it('ignores every secret filename in every Worker directory, including ones not yet created', () => {
    const dirs = [
      ...new Set([
        ...workerDirs(),
        // A directory nobody has thought of yet. The rule has to cover it too,
        // or this test only ever documents the past.
        'cloudflare-some-future-worker',
      ]),
    ];

    const gaps = dirs.flatMap(d =>
      SECRET_FILENAMES.filter(name => !isIgnored(`${d}/${name}`)).map(name => `${d}/${name}`),
    );

    expect(gaps).toEqual([]);
  });

  it('ignores every secret filename at the repo root', () => {
    expect(SECRET_FILENAMES.filter(name => !isIgnored(name))).toEqual([]);
  });

  it('keeps .dev.vars.example committable, or the template is unusable', () => {
    expect(isIgnored('cloudflare-clubworx/.dev.vars.example')).toBe(false);
  });

  it('tracks no secret file anywhere in the repo', () => {
    const tracked = git('ls-files')
      .split('\n')
      .filter(f => SECRET_FILENAMES.includes(path.basename(f)));

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
    //
    // Nothing is excused by path. An earlier version skipped docs/, reasoning
    // that the API reference is example URLs — but that reference lives in
    // uj/automations/, a different repo, so the exemption covered nothing real
    // while blinding the check to exactly where someone pastes a curl example.
    const PLACEHOLDER = /^(your-unique-digital-key|unique-|<|\$|\{)/;

    const hits = gitGrep('account_key=[A-Za-z0-9_-]{8,}').filter(line => {
      const value = line.match(/account_key=([A-Za-z0-9_-]{8,})/)?.[1] ?? '';
      return !PLACEHOLDER.test(value);
    });

    expect(hits).toEqual([]);
  });
});
