// vouchers/scripts/version.mjs
// The single source of the build version shown on the voucher hub. Run by the
// Pages workflow, which redirects its stdout to vouchers/version.json:
//
//   node vouchers/scripts/version.mjs > vouchers/version.json
//
// Every field is derived from git. Nothing here is hand-typed and nothing is
// committed, because the hub is a static page with no build step: a version
// carried in the repository could describe a build other than the one being
// served, and a version that lies is worse than no version at all.
//
// Nothing here may throw. This runs on the deploy path, so a generator that can
// fail is a generator that can stop the site publishing. Every git call is
// wrapped and every failure lands on DEV_VERSION.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// Scoped to the voucher hub on purpose: the count is the version, and it should
// move when the hub moves — not when the roster page or the HVT copy does.
const HUB_DIR = path.resolve(import.meta.dirname, '..');

export const DEV_VERSION = { version: 'dev', sha: '' };

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

// runGit exists so the tests can drive the failure paths without mangling a real
// repository; the workflow calls computeVersion() with no arguments.
export function computeVersion({ cwd = HUB_DIR, runGit = git } = {}) {
  const builtAt = new Date().toISOString();
  try {
    // A shallow checkout answers `rev-list --count` with 1 and reports no
    // error, which would pin the version at a plausible-looking number forever.
    // The workflow sets fetch-depth: 0; this is what catches it if that is ever
    // dropped. Anything other than a flat "false" is treated as shallow.
    if (runGit(['rev-parse', '--is-shallow-repository'], cwd) !== 'false') return { ...DEV_VERSION, builtAt };

    const count = runGit(['rev-list', '--count', 'HEAD', '--', '.'], cwd);
    const sha = runGit(['rev-parse', '--short=7', 'HEAD'], cwd);
    if (!/^\d+$/.test(count) || !/^[0-9a-f]{7}$/.test(sha)) return { ...DEV_VERSION, builtAt };

    return { version: count, sha, builtAt };
  } catch {
    // No .git, git not installed, a detached or empty repository — all the same
    // answer: the deploy proceeds, the page says "dev".
    return { ...DEV_VERSION, builtAt };
  }
}

// CLI mode. stdout rather than an fs write, so this file keeps one job and the
// caller decides where the JSON lands.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  console.log(JSON.stringify(computeVersion()));
}
