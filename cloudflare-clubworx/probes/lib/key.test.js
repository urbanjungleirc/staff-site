import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadAccountKey } from './key.mjs';

// Where the live Clubworx key comes from. One copy, because this function also
// produces the message that tells someone how to fix a missing key — two copies
// drift, and the one that drifts is the one nobody reads.

const withDevVars = contents => {
  const dir = mkdtempSync(path.join(tmpdir(), 'uj-clubworx-'));
  const file = path.join(dir, '.dev.vars');
  writeFileSync(file, contents);
  return file;
};

describe('loadAccountKey', () => {
  it('reads the key out of a .dev.vars file', () => {
    expect(loadAccountKey(withDevVars('CLUBWORX_ACCOUNT_KEY=abc123\n'))).toBe('abc123');
  });

  it('ignores the other lines around it', () => {
    const file = withDevVars('# a comment\nOTHER=1\nCLUBWORX_ACCOUNT_KEY=abc123\nMORE=2\n');
    expect(loadAccountKey(file)).toBe('abc123');
  });

  it('keeps a key that contains "="', () => {
    // Base64-ish keys end in padding. Splitting on the first = and taking [1]
    // would silently truncate the credential and produce a 401 nobody can explain.
    expect(loadAccountKey(withDevVars('CLUBWORX_ACCOUNT_KEY=abc==\n'))).toBe('abc==');
  });

  it('trims surrounding whitespace', () => {
    expect(loadAccountKey(withDevVars('  CLUBWORX_ACCOUNT_KEY=abc123  \n'))).toBe('abc123');
  });

  it('does not read a commented-out key', () => {
    expect(() => loadAccountKey(withDevVars('# CLUBWORX_ACCOUNT_KEY=abc123\n'))).toThrow();
  });

  it('explains how to fix a missing file, naming the template and ACCESS.md', () => {
    const missing = path.join(mkdtempSync(path.join(tmpdir(), 'uj-clubworx-')), '.dev.vars');
    expect(() => loadAccountKey(missing)).toThrow(/\.dev\.vars\.example/);
    expect(() => loadAccountKey(missing)).toThrow(/ACCESS\.md/);
  });

  it('rejects a present-but-empty key rather than sending a blank one', () => {
    expect(() => loadAccountKey(withDevVars('CLUBWORX_ACCOUNT_KEY=\n'))).toThrow(/missing or empty/);
  });

  it('never puts the key in the error message', () => {
    // The failure path is the one that gets pasted into a terminal, an issue
    // comment, or a public repo.
    const file = withDevVars('CLUBWORX_ACCOUNT_KEY=\n');
    try {
      loadAccountKey(file);
    } catch (err) {
      expect(err.message).not.toContain('CLUBWORX_ACCOUNT_KEY=');
    }
  });
});
