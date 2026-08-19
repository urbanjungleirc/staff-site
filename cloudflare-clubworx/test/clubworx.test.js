import { describe, it, expect } from 'vitest';
import { createClubworxClient } from '../src/clubworx.js';
import { createPacer } from '../src/pace.js';

// The Worker's only path to Clubworx. Everything asserted here is measured
// behaviour from probes/ — the JSON POST, the form-encoded DELETE, the key in
// the query string — plus the two rules the Worker adds on top: it paces, and
// the key never leaves in anything it hands back.

const KEY = 'super-secret-gym-key-1234';

/** A fetch stub recording exactly what was sent. */
function recorder(responder) {
  const impl = async (url, init) => {
    impl.sent.push({ url: String(url), ...init });
    return responder(String(url), init);
  };
  impl.sent = [];
  return impl;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/** No waiting in tests — the pacer's own schedule is pinned in pace.test.js. */
const instantPacer = () => createPacer({ now: () => 0, sleep: async () => {} });

const clientWith = (fetchImpl, over = {}) =>
  createClubworxClient({ accountKey: KEY, fetchImpl, pacer: instantPacer(), ...over });

describe('construction', () => {
  it('refuses to build without an account key rather than calling anonymously', () => {
    expect(() => createClubworxClient({ accountKey: '', fetchImpl: recorder(() => json({})) })).toThrow(
      /account key/i,
    );
  });
});

describe('GET', () => {
  it('sends the key as a query parameter and asks for JSON', async () => {
    const fetchImpl = recorder(() => json({ events: [] }));
    const client = clientWith(fetchImpl);

    await client.get('events', { page_size: 100 });

    const sent = fetchImpl.sent[0];
    expect(sent.url).toContain('https://app.clubworx.com/api/v2/events?');
    expect(sent.url).toContain(`account_key=${KEY}`);
    expect(sent.url).toContain('page_size=100');
    expect(sent.method).toBe('GET');
    expect(sent.headers.Accept).toBe('application/json');
  });

  it('hands back the parsed body and the status', async () => {
    const client = clientWith(recorder(() => json({ contacts: [{ id: 1 }] })));
    const res = await client.get('contacts');

    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ contacts: [{ id: 1 }] });
    expect(res.message).toBeNull();
  });

  it('keeps an omitted parameter omitted and a blank one blank', async () => {
    // #51 turns on telling those two apart for contact_key, so the distinction
    // must survive this layer rather than being normalised away.
    const fetchImpl = recorder(() => json({}));
    const client = clientWith(fetchImpl);

    await client.get('events', { contact_key: '', page: undefined });

    expect(fetchImpl.sent[0].url).toContain('contact_key=');
    expect(fetchImpl.sent[0].url).not.toContain('page=');
  });
});

describe('POST — measured as a JSON body with the key still in the query', () => {
  it('sends JSON and reports a Clubworx refusal in words', async () => {
    const fetchImpl = recorder(() => json({ error: 'Contact has no active membership' }, 400));
    const client = clientWith(fetchImpl);

    const res = await client.post('bookings', { contact_key: 'ck-1', event_id: 7 });

    const sent = fetchImpl.sent[0];
    expect(sent.method).toBe('POST');
    expect(sent.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(sent.body)).toEqual({ contact_key: 'ck-1', event_id: 7 });
    expect(sent.url).toContain(`account_key=${KEY}`);

    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    expect(res.message).toBe('Contact has no active membership');
  });

  it('treats 200 as success, since Clubworx answers 200 and not 201 on create', async () => {
    const client = clientWith(recorder(() => json({ contact_key: 'ck-new' }, 200)));
    expect((await client.post('members', {})).ok).toBe(true);
  });

  it('never puts the account key in the body', async () => {
    const fetchImpl = recorder(() => json({}));
    const client = clientWith(fetchImpl);

    await client.post('members', { first_name: 'Ztest' });

    expect(fetchImpl.sent[0].body).not.toContain(KEY);
  });
});

describe('DELETE — measured as form-encoded, and it needs contact_key', () => {
  it('form-encodes the body, the shape that made DELETE /bookings work', async () => {
    // Sent any other way, Clubworx answers 401 "Authorization failed", which
    // reads exactly like a permissions problem and was misread as one (#50/#60).
    const fetchImpl = recorder(() => json({ success: true }));
    const client = clientWith(fetchImpl);

    await client.del('bookings/bk-1', { contact_key: 'ck-1' });

    const sent = fetchImpl.sent[0];
    expect(sent.method).toBe('DELETE');
    expect(sent.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(sent.body).toBe('contact_key=ck-1');
    expect(sent.url).toContain(`account_key=${KEY}`);
  });
});

describe('the key never leaves in anything handed back', () => {
  it('redacts the key out of a network error message', async () => {
    // node interpolates the URL into connection errors, and the URL carries the
    // key. An unredacted throw is how a gym key reaches a log line.
    const client = clientWith(async () => {
      throw new Error(`connect ECONNREFUSED for https://app.clubworx.com/api/v2/events?account_key=${KEY}`);
    });

    const res = await client.get('events');

    expect(res.ok).toBe(false);
    expect(res.networkError).toBe(true);
    expect(res.message).not.toContain(KEY);
    expect(res.message).toContain('<CLUBWORX_ACCOUNT_KEY>');
  });

  it('redacts the key out of a non-JSON body, which is what a throttle returns', async () => {
    const client = clientWith(
      async () => new Response(`<html>blocked ${KEY}</html>`, { status: 429 }),
    );

    const res = await client.get('events');

    expect(res.status).toBe(429);
    expect(res.body).toBeNull();
    expect(res.nonJson).toBe(true);
    expect(res.bodyText).not.toContain(KEY);
  });

  it('reports the url it called with the key removed', async () => {
    const client = clientWith(recorder(() => json({})));
    const res = await client.get('events');

    expect(res.url).toContain('app.clubworx.com/api/v2/events');
    expect(res.url).not.toContain(KEY);
  });

  it('bounds a non-JSON body rather than carrying a whole error page around', async () => {
    const client = clientWith(async () => new Response('x'.repeat(5000), { status: 502 }));
    const res = await client.get('events');

    expect(res.bodyText.length).toBeLessThanOrEqual(500);
  });
});

describe('pacing', () => {
  it('sends every call through the pacer', async () => {
    const pacer = instantPacer();
    const client = clientWith(recorder(() => json({})), { pacer });

    await client.get('events');
    await client.post('members', {});
    await client.del('bookings/1', { contact_key: 'ck' });

    expect(pacer.calls).toBe(3);
  });

  it('leaves the measured gap between two calls', async () => {
    let t = 0;
    const pacer = createPacer({
      now: () => t,
      sleep: async ms => {
        t += ms;
      },
    });
    const at = [];
    const client = clientWith(
      recorder(() => {
        at.push(t);
        return json({});
      }),
      { pacer },
    );

    await client.get('events');
    await client.get('events');

    expect(at).toEqual([0, 800]);
  });

  it('never runs two Clubworx calls at once', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const client = clientWith(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return json({});
    });

    await Promise.all([client.get('a'), client.get('b'), client.get('c')]);

    expect(maxInFlight).toBe(1);
  });
});

describe('timing', () => {
  it('reports how long the call took', async () => {
    const client = clientWith(recorder(() => json({})));
    const res = await client.get('events');

    expect(typeof res.ms).toBe('number');
    expect(res.ms).toBeGreaterThanOrEqual(0);
  });
});
