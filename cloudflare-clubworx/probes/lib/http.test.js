import { describe, it, expect } from 'vitest';
import { createGetter } from './http.mjs';

// This wrapper is the only way a probe reaches Clubworx, and Clubworx has no
// sandbox. Everything asserted here is a safety property of hitting a live
// 60,000-person production database from a public repo.

const fakeFetch = (calls, response = {}) => {
  return async (url, init) => {
    calls.push({ url, init });
    return {
      status: response.status ?? 200,
      headers: new Headers(response.headers ?? { 'content-type': 'application/json' }),
      text: async () => response.text ?? '[]',
    };
  };
};

describe('createGetter', () => {
  const key = 'KEY123456';

  it('issues GET and nothing else — every probe on this map is read-only', async () => {
    const calls = [];
    await createGetter({ accountKey: key, fetchImpl: fakeFetch(calls) })('events');
    expect(calls[0].init.method).toBe('GET');
  });

  it('asks for JSON, as the API reference does', async () => {
    const calls = [];
    await createGetter({ accountKey: key, fetchImpl: fakeFetch(calls) })('events');
    expect(calls[0].init.headers.Accept).toBe('application/json');
  });

  it('reports the url with the key redacted, never the raw one', async () => {
    const get = createGetter({ accountKey: key, fetchImpl: fakeFetch([]) });
    const res = await get('events', { page: 1 });
    expect(res.url).toContain('<CLUBWORX_ACCOUNT_KEY>');
    expect(res.url).not.toContain(key);
  });

  it('returns status, timing, headers and parsed body', async () => {
    const get = createGetter({
      accountKey: key,
      fetchImpl: fakeFetch([], { status: 200, text: '[{"event_id":7}]' }),
    });
    const res = await get('events');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ event_id: 7 }]);
    expect(typeof res.ms).toBe('number');
  });

  it('keeps an unparseable body as text rather than throwing', async () => {
    // A 429 or a WAF block is usually HTML. Throwing there would abandon the
    // burst at exactly the sample worth recording.
    const get = createGetter({
      accountKey: key,
      fetchImpl: fakeFetch([], { status: 429, text: '<html>Too Many Requests</html>' }),
    });
    const res = await get('events');
    expect(res.status).toBe(429);
    expect(res.bodyText).toContain('Too Many Requests');
    expect(res.body).toBeNull();
  });

  it('turns a transport failure into a sample instead of crashing the run', async () => {
    const get = createGetter({
      accountKey: key,
      fetchImpl: async () => {
        throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      },
    });
    const res = await get('events');
    expect(res.error).toBe('ECONNRESET');
    expect(res.status).toBeNull();
  });

  it('never lets the key reach an error message', async () => {
    const get = createGetter({
      accountKey: key,
      fetchImpl: async url => {
        throw new Error(`connect failed for ${url}`);
      },
    });
    const res = await get('events');
    expect(JSON.stringify(res)).not.toContain(key);
  });

  it('counts every call it makes, so a probe cannot quietly cost more than it says', async () => {
    const get = createGetter({ accountKey: key, fetchImpl: fakeFetch([]) });
    await get('events');
    await get('members');
    expect(get.calls).toBe(2);
  });
});
