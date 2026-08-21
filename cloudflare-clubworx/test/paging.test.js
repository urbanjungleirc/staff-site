import { describe, it, expect } from 'vitest';
import { PAGE_SIZE, pageThrough } from '../src/paging.js';

// The one rule three routes are built on: Clubworx sends no total, no next-page
// link and no header, so a page that came back exactly full is indistinguishable
// from a complete list. Reading one as an answer is what returned 50 of 57 plans
// with School Pass among the missing (#60), and what shows 50 of a term's events
// as though they were all of them (#51).
//
// Everything below is that rule from a different angle. What the ceiling MEANS is
// deliberately not decided here — `truncated` is reported, never interpreted,
// because on /plan it is a refusal and on /events it is a flag.

const rows = n => Array.from({ length: n }, (_, i) => ({ id: i }));

function clientWith(pages, over = {}) {
  const calls = [];
  return {
    calls,
    get: async (path, params) => {
      calls.push({ path, params });
      return {
        ok: true,
        status: 200,
        url: `https://app.clubworx.com/api/v2/${path}`,
        ms: 1,
        body: pages[params.page] ?? [],
        nonJson: false,
        bodyText: null,
        message: null,
        networkError: false,
        ...over,
      };
    },
  };
}

const walk = (client, over = {}) =>
  pageThrough({ client, path: 'things', maxPages: 3, what: 'things', ...over });

describe('pageThrough', () => {
  it('asks for a page size past the default 50, which is the trap', async () => {
    const client = clientWith({ 1: rows(2) });
    await walk(client);

    expect(client.calls[0].params.page_size).toBe(PAGE_SIZE);
    expect(PAGE_SIZE).toBeGreaterThan(50);
  });

  it('carries the caller parameters alongside the paging ones', async () => {
    const client = clientWith({ 1: rows(2) });
    await walk(client, { params: { email: 'noreply+' } });

    expect(client.calls[0].params).toMatchObject({ email: 'noreply+', page: 1, page_size: PAGE_SIZE });
  });

  it('stops on a short page — the only end-of-list signal Clubworx offers', async () => {
    const client = clientWith({ 1: rows(3) });
    const result = await walk(client);

    expect(client.calls).toHaveLength(1);
    expect(result.pages).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it('treats a page that came back exactly full as unfinished', async () => {
    const client = clientWith({ 1: rows(PAGE_SIZE), 2: rows(1) });
    const result = await walk(client);

    expect(client.calls.map(c => c.params.page)).toEqual([1, 2]);
    expect(result.rows).toHaveLength(PAGE_SIZE + 1);
    expect(result.truncated).toBe(false);
  });

  it('stops at the ceiling and reports it, rather than walking without bound', async () => {
    const client = clientWith({ 1: rows(PAGE_SIZE), 2: rows(PAGE_SIZE), 3: rows(PAGE_SIZE) });
    const result = await walk(client);

    expect(client.calls).toHaveLength(3);
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
  });

  it('reports the ceiling without deciding what it means', async () => {
    // `/plan` must refuse on this and `/events` must flag it. A module that
    // picked one would make "not found" mean "not looked for" on the other.
    const client = clientWith({ 1: rows(PAGE_SIZE), 2: rows(PAGE_SIZE), 3: rows(PAGE_SIZE) });
    const result = await walk(client);

    expect(result).not.toHaveProperty('reason');
    expect(result.ok).toBe(true);
  });

  it('tells a throttle apart from every other upstream failure', async () => {
    const client = clientWith({}, { ok: false, status: 429, body: null, bodyText: 'slow down' });
    const result = await walk(client);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('throttled');
    expect(result.upstreamStatus).toBe(429);
  });

  it('reports a network failure as itself', async () => {
    const client = clientWith({}, { ok: false, status: 0, body: null, networkError: true, message: 'connection reset' });
    const result = await walk(client);

    expect(result.reason).toBe('network');
    expect(result.message).toBe('connection reset');
  });

  it('abandons the walk on the first failure rather than retrying it', async () => {
    // Deliberate, and the same choice contacts.js made. A 429 pauses the whole
    // run (§11), not one read, and retrying here would hide it from the only
    // layer that can act on it.
    const client = clientWith({}, { ok: false, status: 500, body: null, message: 'boom' });
    await walk(client);

    expect(client.calls).toHaveLength(1);
  });

  it('refuses a 200 whose body is not a list, naming the endpoint and what it wanted', async () => {
    const client = clientWith({}, { body: { things: [] } });
    const result = await walk(client);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('upstream-error');
    expect(result.message).toContain('things');
  });

  it('counts requests, and continues a count a caller started', async () => {
    const client = clientWith({ 1: rows(PAGE_SIZE), 2: rows(1) });
    const result = await walk(client, { requests: 5 });

    expect(result.requests).toBe(7);
  });
});
