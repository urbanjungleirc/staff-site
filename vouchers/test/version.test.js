import { describe, expect, test } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { computeVersion, DEV_VERSION } from '../scripts/version.mjs';

// This module exists so a stale copy of the voucher hub can be told apart from a
// current one, and it runs on the deploy path — so the only thing it must never
// do is throw. Every failure below has to land on the same `dev` shape rather
// than take the deploy down with it. See docs/adr/0004-voucher-hub-build-version.md.

// A runGit stub whose replies are scripted per git subcommand, so the failure
// paths can be driven without mangling a real repository.
function stubGit(replies) {
  return (args) => {
    const key = args.slice(0, 2).join(' ');
    const reply = replies[key];
    if (reply === undefined) throw new Error(`unexpected git call: ${args.join(' ')}`);
    if (reply instanceof Error) throw reply;
    return reply;
  };
}

const HEALTHY = {
  'rev-parse --is-shallow-repository': 'false',
  'rev-list --count': '128',
  'rev-parse --short=7': 'a3f9c21',
};

describe('computeVersion', () => {
  test('reports the commit count, the short SHA and an ISO build time', () => {
    const v = computeVersion({ runGit: stubGit(HEALTHY) });

    expect(v.version).toBe('128');
    expect(v.sha).toBe('a3f9c21');
    expect(new Date(v.builtAt).toISOString()).toBe(v.builtAt);
  });

  test('carries build metadata only', () => {
    // The staff site is static and its files are fetchable by anyone who can
    // reach the origin, so the payload must never grow environment,
    // configuration or people fields.
    expect(Object.keys(computeVersion({ runGit: stubGit(HEALTHY) })).sort())
      .toEqual(['builtAt', 'sha', 'version']);
  });

  test('reads its three facts from this repository for real', () => {
    // The stubs above pin the shape; this pins the wiring — that the arguments
    // actually asked of git produce a count and a SHA in this checkout.
    const v = computeVersion();

    expect(v.version).toMatch(/^\d+$/);
    expect(Number(v.version)).toBeGreaterThan(0);
    expect(v.sha).toMatch(/^[0-9a-f]{7}$/);
  });

  test('counts only commits that touched the voucher hub', () => {
    // The count is the version, so it has to move when the hub moves and stay
    // put when the roster or the HVT copy does. Scoping is by pathspec, which
    // is silent when it is wrong — hence an explicit check that the hub's count
    // is strictly below the repository's own.
    const whole = computeVersion({ cwd: path.resolve(import.meta.dirname, '../..') });

    expect(Number(computeVersion().version)).toBeLessThan(Number(whole.version));
  });

  test('falls back to dev when git is unavailable', () => {
    const v = computeVersion({ runGit: () => { throw new Error('git: not found'); } });

    expect(v).toMatchObject(DEV_VERSION);
    expect(v.builtAt).not.toBe('');
  });

  test('falls back to dev outside a git repository', () => {
    // A tarball export, or the site staged into a scratch directory.
    expect(computeVersion({ cwd: mkdtempSync(path.join(tmpdir(), 'uj-version-')) }))
      .toMatchObject(DEV_VERSION);
  });

  test('falls back to dev in a shallow clone rather than reporting a wrong count', () => {
    // `git rev-list --count` answers 1 under `--depth 1` and reports no error,
    // so an unguarded generator would pin the version at a plausible-looking
    // number forever. A version that lies is worse than one that says "dev".
    const v = computeVersion({
      runGit: stubGit({ ...HEALTHY, 'rev-parse --is-shallow-repository': 'true' }),
    });

    expect(v).toMatchObject(DEV_VERSION);
  });

  test('falls back to dev when git answers with something that is not a count', () => {
    expect(computeVersion({ runGit: stubGit({ ...HEALTHY, 'rev-list --count': '' }) }))
      .toMatchObject(DEV_VERSION);
    expect(computeVersion({ runGit: stubGit({ ...HEALTHY, 'rev-list --count': 'fatal: bad revision' }) }))
      .toMatchObject(DEV_VERSION);
  });

  test('falls back to dev when git answers with something that is not a SHA', () => {
    expect(computeVersion({ runGit: stubGit({ ...HEALTHY, 'rev-parse --short=7': '' }) }))
      .toMatchObject(DEV_VERSION);
    expect(computeVersion({ runGit: stubGit({ ...HEALTHY, 'rev-parse --short=7': 'HEAD' }) }))
      .toMatchObject(DEV_VERSION);
  });
});
