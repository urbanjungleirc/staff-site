import { describe, expect, test } from 'vitest';
import { formatBuildVersion } from '../version-display.js';

// The footer version exists so a stale cached copy of the hub can be spotted.
// That makes a *wrong* version worse than none: it reports a stale build as
// current, with the authority of being printed on the page. So every input this
// function does not fully trust has to render as nothing at all, leaving the
// footer showing the signed-in email alone.
// See docs/adr/0004-voucher-hub-build-version.md.

const BUILT = { version: '66', sha: 'da9185f', builtAt: '2026-08-07T10:14:50.591Z' };

describe('formatBuildVersion', () => {
  test('renders version, short SHA and the build time in Perth', () => {
    // 10:14 UTC is 18:14 in Perth (UTC+8, no DST) — the same day, here.
    expect(formatBuildVersion(BUILT)).toBe('v66 · da9185f · 7 Aug 18:14');
  });

  test('puts the build time in Perth even when that changes the date', () => {
    // 20:30 UTC on the 6th is 04:30 on the 7th in Perth. Rendering the UTC date
    // would have the footer disagree with every other date in the voucher
    // system, which are all Perth.
    expect(formatBuildVersion({ ...BUILT, builtAt: '2026-08-06T20:30:00.000Z' }))
      .toBe('v66 · da9185f · 7 Aug 04:30');
  });

  test('renders midnight as 00:00, not 24:00', () => {
    // hour12:false is specified to permit a broken h24 cycle that renders
    // midnight as "24:00"; hourCycle:"h23" is the knob that does not.
    expect(formatBuildVersion({ ...BUILT, builtAt: '2026-08-06T16:00:00.000Z' }))
      .toBe('v66 · da9185f · 7 Aug 00:00');
  });

  test('abbreviates the month', () => {
    // en-AU renders month:"short" as "July" rather than "Jul", so the locale
    // here is en-GB deliberately. This catches a well-meaning "fix" to en-AU.
    expect(formatBuildVersion({ ...BUILT, builtAt: '2026-07-19T10:36:00.000Z' }))
      .toBe('v66 · da9185f · 19 Jul 18:36');
  });

  test('shows nothing for the dev version', () => {
    // What the generator emits whenever git could not be trusted. It is not an
    // error, and it is not something staff should be shown.
    expect(formatBuildVersion({ version: 'dev', sha: '', builtAt: BUILT.builtAt })).toBe('');
  });

  test('shows nothing when there is no version file at all', () => {
    // The normal state in local development, where version.json is never
    // generated, and after any failed fetch.
    expect(formatBuildVersion(undefined)).toBe('');
    expect(formatBuildVersion(null)).toBe('');
    expect(formatBuildVersion({})).toBe('');
  });

  test('shows nothing for a version that is not a build number', () => {
    // The generator only ever emits digits or "dev". Anything else means we are
    // reading something other than what we think, so print none of it.
    expect(formatBuildVersion({ ...BUILT, version: '0.1.48' })).toBe('');
    expect(formatBuildVersion({ ...BUILT, version: 'v66' })).toBe('');
    expect(formatBuildVersion({ ...BUILT, version: 66 })).toBe('');
    expect(formatBuildVersion({ ...BUILT, version: '' })).toBe('');
  });

  test('drops a SHA that is not a short SHA, keeping the rest', () => {
    // A partial payload still answers "which build?" usefully. Dropping only
    // the bad field beats dropping the line.
    expect(formatBuildVersion({ ...BUILT, sha: '' })).toBe('v66 · 7 Aug 18:14');
    expect(formatBuildVersion({ ...BUILT, sha: 'HEAD' })).toBe('v66 · 7 Aug 18:14');
    expect(formatBuildVersion({ ...BUILT, sha: 'DA9185F' })).toBe('v66 · 7 Aug 18:14');
  });

  test('drops a build time that is not a date, keeping the rest', () => {
    expect(formatBuildVersion({ ...BUILT, builtAt: 'yesterday' })).toBe('v66 · da9185f');
    expect(formatBuildVersion({ ...BUILT, builtAt: '' })).toBe('v66 · da9185f');
    expect(formatBuildVersion({ version: '66' })).toBe('v66');
  });
});
