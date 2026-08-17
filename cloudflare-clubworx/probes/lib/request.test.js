import { describe, it, expect } from 'vitest';
import { buildUrl, redact } from './request.mjs';

// The two things a probe against a public repo's live production API must get
// right before it makes a single call: the URL it asks for, and the text it is
// allowed to print afterwards.
//
// The fake key starts with `unique-` on purpose. cloudflare-worker/test/
// secret-hygiene.test.js greps every tracked file for a real-looking value on
// the account key query parameter, and treats that prefix as a declared
// placeholder. A fixture named anything else fails the guard — correctly, since
// from the outside an invented key and a real one are the same string of
// characters. Naming one here in an example would trip it too.

describe('buildUrl', () => {
  const opts = { path: 'events', accountKey: 'unique-not-a-real-key' };

  it('puts the account key on every request, because all 42 endpoints require it', () => {
    expect(buildUrl(opts)).toContain('account_key=unique-not-a-real-key');
  });

  it('hits the documented api/v2 base', () => {
    expect(buildUrl(opts).startsWith('https://app.clubworx.com/api/v2/events?')).toBe(true);
  });

  // The whole point of #51 is telling three cases apart: no contact_key at all,
  // a present-but-empty one, and an arbitrary one. A builder that collapses the
  // first two answers a different question than the one asked.
  it('omits a parameter given as undefined', () => {
    const url = buildUrl({ ...opts, params: { contact_key: undefined } });
    expect(url).not.toContain('contact_key');
  });

  it('keeps a parameter given as an empty string, as a present-but-blank value', () => {
    const url = buildUrl({ ...opts, params: { contact_key: '' } });
    expect(url).toContain('contact_key=');
    expect(new URL(url).searchParams.get('contact_key')).toBe('');
  });

  it('encodes values rather than pasting them in raw', () => {
    const url = buildUrl({ ...opts, params: { last_name: "O'Brien & Sons" } });
    expect(new URL(url).searchParams.get('last_name')).toBe("O'Brien & Sons");
    expect(url).not.toContain(' ');
  });

  it('orders parameters deterministically, so two runs produce comparable URLs', () => {
    const a = buildUrl({ ...opts, params: { page: 1, event_starts_after: '2026-08-01' } });
    const b = buildUrl({ ...opts, params: { event_starts_after: '2026-08-01', page: 1 } });
    expect(a).toBe(b);
  });

  it('refuses to build a URL with no key rather than sending an unauthenticated request', () => {
    expect(() => buildUrl({ path: 'events', accountKey: '' })).toThrow(/account key/i);
  });
});

describe('redact', () => {
  it('replaces the key wherever it appears', () => {
    expect(redact('GET /events?account_key=unique-not-a-real-key&page=1', 'unique-not-a-real-key')).toBe(
      'GET /events?account_key=<CLUBWORX_ACCOUNT_KEY>&page=1',
    );
  });

  it('replaces every occurrence, not just the first', () => {
    const out = redact('unique-not-a-real-key ... unique-not-a-real-key', 'unique-not-a-real-key');
    expect(out).not.toContain('unique-not-a-real-key');
  });

  it('catches a percent-encoded copy of the key, which a naive replace would miss', () => {
    const key = 'abc+def/ghi';
    const out = redact(`url=${encodeURIComponent(key)}`, key);
    expect(out).not.toContain('abc%2Bdef');
    expect(out).toContain('<CLUBWORX_ACCOUNT_KEY>');
  });

  it('handles a key carrying regex metacharacters without corrupting the text', () => {
    expect(redact('x=a.b*c y=1', 'a.b*c')).toBe('x=<CLUBWORX_ACCOUNT_KEY> y=1');
    // The literal dot must not have matched the arbitrary character before it.
    expect(redact('x=aXbbbc', 'a.b*c')).toBe('x=aXbbbc');
  });

  it('throws on an empty secret instead of silently redacting nothing', () => {
    // A redactor that quietly no-ops is worse than none: callers stop checking.
    expect(() => redact('anything', '')).toThrow(/secret/i);
  });

  it('leaves non-string input alone by stringifying it first', () => {
    expect(redact(404, 'unique-not-a-real-key')).toBe('404');
  });
});
