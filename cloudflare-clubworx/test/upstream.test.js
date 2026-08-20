import { describe, it, expect } from 'vitest';
import { isRetryable, upstreamReason, upstreamMessage } from '../src/upstream.js';

describe('isRetryable — D8', () => {
  it('retries a throttle, a 5xx and a connection failure', () => {
    expect(isRetryable({ status: 429 })).toBe(true);
    expect(isRetryable({ status: 500 })).toBe(true);
    expect(isRetryable({ status: 503 })).toBe(true);
    expect(isRetryable({ status: 0, networkError: true })).toBe(true);
  });

  it('NEVER retries a 400 — all three known ones are permanent for that attempt', () => {
    expect(isRetryable({ status: 400 })).toBe(false);
  });

  it('does not retry the other 4xx either, including the one that means a missing parameter', () => {
    // 401 "Authorization failed" on a DELETE means contact_key is missing (#50).
    // Sending it again unchanged cannot work.
    expect(isRetryable({ status: 401 })).toBe(false);
    expect(isRetryable({ status: 403 })).toBe(false);
    expect(isRetryable({ status: 404 })).toBe(false);
  });

  it('does not retry a success', () => {
    expect(isRetryable({ status: 200, ok: true })).toBe(false);
  });
});

describe('upstreamReason', () => {
  it('names a throttle as itself, because it pauses the whole run', () => {
    expect(upstreamReason({ status: 429 })).toBe('throttled');
  });

  it('tells a connection failure apart from an upstream answer', () => {
    expect(upstreamReason({ status: 0, networkError: true })).toBe('network');
    expect(upstreamReason({ status: 500 })).toBe('upstream-error');
  });

  it('prefers the throttle even on a network-flagged 429', () => {
    expect(upstreamReason({ status: 429, networkError: true })).toBe('throttled');
  });
});

describe('upstreamMessage', () => {
  it('prefers the extracted message over the raw body text', () => {
    expect(upstreamMessage({ message: 'nope', bodyText: '<html>' })).toBe('nope');
  });

  it('falls back to the scrubbed body text when there is no JSON message', () => {
    expect(upstreamMessage({ message: null, bodyText: '<html>too many</html>' })).toBe(
      '<html>too many</html>',
    );
  });

  it('answers null rather than inventing a message', () => {
    expect(upstreamMessage({})).toBeNull();
  });
});
