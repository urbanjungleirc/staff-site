import { describe, it, expect } from 'vitest';
import { createPoster } from './write.mjs';
import { PROBE_CONTACTS } from './identity.mjs';

// The only path out to Clubworx that can create anything. Clubworx cannot
// delete a contact through the API, so a mistake made here is permanent in a
// production database holding ~60,000 real people. Every assertion below is a
// property that keeps an accidental or malformed write from happening at all,
// rather than being noticed afterwards.

const key = 'unique-not-a-real-key';
const contact = PROBE_CONTACTS[0];

const fakeFetch = (calls, response = {}) => async (url, init) => {
  calls.push({ url, init });
  return {
    status: response.status ?? 201,
    headers: new Headers(response.headers ?? { 'content-type': 'application/json' }),
    text: async () => response.text ?? '{"contact_key":"ck-1"}',
  };
};

describe('createPoster', () => {
  it('does not touch the network unless writing is explicitly enabled', async () => {
    // The default is inert. Importing this module, or forgetting a flag, must
    // not be enough to create a permanent record.
    const calls = [];
    const post = createPoster({ accountKey: key, fetchImpl: fakeFetch(calls) });

    const res = await post('prospects', contact);

    expect(calls).toHaveLength(0);
    expect(res.dryRun).toBe(true);
  });

  it('reports what a dry run would have sent, so --dry-run is reviewable', async () => {
    const post = createPoster({ accountKey: key, fetchImpl: fakeFetch([]) });
    const res = await post('prospects', contact);

    expect(res.wouldSend).toMatchObject({ last_name: contact.last_name, email: contact.email });
    expect(res.status).toBeNull();
  });

  it('issues POST when live', async () => {
    const calls = [];
    const post = createPoster({ accountKey: key, fetchImpl: fakeFetch(calls), live: true });

    await post('prospects', contact);

    expect(calls[0].init.method).toBe('POST');
  });

  it('sends the contact as JSON', async () => {
    const calls = [];
    const post = createPoster({ accountKey: key, fetchImpl: fakeFetch(calls), live: true });

    await post('prospects', contact);

    expect(calls[0].init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(calls[0].init.body)).toMatchObject({
      first_name: contact.first_name,
      last_name: contact.last_name,
      email: contact.email,
      dob: contact.dob,
    });
  });

  it('strips the probe’s own bookkeeping fields from what it sends', async () => {
    // `label` and `why` exist for the write-up and the cleanup list. Posting
    // them would put junk on a permanent record.
    const calls = [];
    const post = createPoster({ accountKey: key, fetchImpl: fakeFetch(calls), live: true });

    await post('prospects', contact);

    const sent = JSON.parse(calls[0].init.body);
    expect(sent.label).toBeUndefined();
    expect(sent.why).toBeUndefined();
  });

  it('refuses a contact that is not the agreed test identity, before any request', async () => {
    // The guard has to fire in front of the network. Refusing after the POST
    // would be a report of a permanent record, not a control.
    const calls = [];
    const post = createPoster({ accountKey: key, fetchImpl: fakeFetch(calls), live: true });

    const res = await post('prospects', { ...contact, first_name: 'Katie' });

    expect(calls).toHaveLength(0);
    expect(res.refused).toMatch(/Ztest/);
    expect(res.status).toBeNull();
  });

  it('refuses an unauthorised identity even in a dry run', async () => {
    const post = createPoster({ accountKey: key, fetchImpl: fakeFetch([]) });
    const res = await post('prospects', { ...contact, email: 'parent@example.com' });
    expect(res.refused).toMatch(/noreply\+/);
  });

  it('reports the url with the key redacted, never the raw one', async () => {
    const post = createPoster({ accountKey: key, fetchImpl: fakeFetch([]), live: true });
    const res = await post('prospects', contact);

    expect(res.url).toContain('<CLUBWORX_ACCOUNT_KEY>');
    expect(res.url).not.toContain(key);
  });

  it('keeps an unparseable body as text rather than throwing', async () => {
    const post = createPoster({
      accountKey: key,
      fetchImpl: fakeFetch([], { status: 422, text: '<html>Unprocessable</html>' }),
      live: true,
    });
    const res = await post('prospects', contact);

    expect(res.status).toBe(422);
    expect(res.bodyText).toContain('Unprocessable');
    expect(res.body).toBeNull();
  });

  it('turns a transport failure into a sample instead of crashing the run', async () => {
    // A write that fails mid-probe must still leave a record of what was
    // attempted — that record is the cleanup list.
    const post = createPoster({
      accountKey: key,
      live: true,
      fetchImpl: async () => {
        throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      },
    });
    const res = await post('prospects', contact);

    expect(res.error).toBe('ECONNRESET');
    expect(res.status).toBeNull();
  });

  it('never lets the key reach an error message', async () => {
    const post = createPoster({
      accountKey: key,
      live: true,
      fetchImpl: async url => {
        throw new Error(`connect failed for ${url}`);
      },
    });
    const res = await post('prospects', contact);

    expect(JSON.stringify(res)).not.toContain(key);
  });

  it('counts the writes it actually made, so a probe cannot quietly create more than it says', async () => {
    const post = createPoster({ accountKey: key, fetchImpl: fakeFetch([]), live: true });

    await post('prospects', contact);
    await post('prospects', PROBE_CONTACTS[1]);
    await post('prospects', { ...contact, first_name: 'Katie' }); // refused

    expect(post.writes).toBe(2);
  });

  it('counts nothing when it is not live', async () => {
    const post = createPoster({ accountKey: key, fetchImpl: fakeFetch([]) });
    await post('prospects', contact);
    expect(post.writes).toBe(0);
  });
});
