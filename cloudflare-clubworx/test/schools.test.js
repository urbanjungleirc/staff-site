import { describe, it, expect } from 'vitest';
import { CONTACT_VIEWS } from '../src/contacts.js';
import { MAX_PAGES, PAGE_SIZE, SCHOOL_EMAIL_PREFIX, listSchools, schoolTagOf } from '../src/schools.js';

// The school picker's read: which `noreply+<tag>@` slugs already exist.
//
// This is the only provenance this system will ever have (§4, §6) — one key per
// gym means attribution by key is impossible — so the tag is what tells an
// operator which school a duplicate belongs to, months later. The cost of a tag
// missing from this list is not a broken picker: it is a staff member typing
// `newmanjhs` beside an existing `newman`, permanently, on contacts that cannot
// be deleted.
//
// Two things that follow:
//
// **It returns tags, not contacts.** `noreply%2B` partial-matches every contact
// this tool has ever created (#49), so the rows behind this answer are hundreds
// of real children. Nothing but the tag, the address to write and a count leaves
// the Worker.
//
// **It searches all three status views.** A contact moves between `/prospects`,
// `/members` and `/non_attending_contacts` as their status changes (#49, #63) —
// a members-only read would lose a school the moment its passes expired.

const contact = (over = {}) => ({
  contact_key: 'ck-1',
  first_name: 'Amelia',
  last_name: 'Nowak',
  dob: '2009-03-02',
  email: 'noreply+newman@urbanjungleirc.com',
  status: 'Member',
  phone: '0400 000 000',
  ...over,
});

const filler = n => Array.from({ length: n }, (_, i) => contact({ contact_key: `ck-${i}` }));

/**
 * A Clubworx client stub: canned pages per view, plus a call recorder.
 *
 * `byView[view]` is either a list of pages (index 0 is page 1) or a single page.
 */
function clientWith(byView, over = {}) {
  const calls = [];
  return {
    calls,
    get: async (path, params = {}) => {
      calls.push({ path, params });
      const answer = byView[path];
      const body = Array.isArray(answer) && Array.isArray(answer[0])
        ? (answer[params.page - 1] ?? [])
        : (answer ?? []);
      return {
        ok: true,
        status: 200,
        url: `https://app.clubworx.com/api/v2/${path}`,
        ms: 1,
        body,
        nonJson: false,
        bodyText: null,
        message: null,
        networkError: false,
        ...over,
      };
    },
  };
}

const inOneView = (view, pages) => clientWith({ [view]: pages });

describe('schoolTagOf', () => {
  it('reads the tag out of a plus-addressed noreply address', () => {
    expect(schoolTagOf('noreply+newman@urbanjungleirc.com')).toBe('newman');
  });

  it('is case-insensitive on the prefix and lowercases the tag it returns', () => {
    // Clubworx stores the address unchanged (#49), and two spellings of one
    // school are the duplicate this list exists to prevent.
    expect(schoolTagOf('NoReply+Newman@urbanjungleirc.com')).toBe('newman');
  });

  it('is domain-agnostic, because the domain is not this module to decide', () => {
    expect(schoolTagOf('noreply+newman@example.org')).toBe('newman');
  });

  it('ignores an address that is not tagged', () => {
    expect(schoolTagOf('noreply@urbanjungleirc.com')).toBe(null);
    expect(schoolTagOf('amelia@example.com')).toBe(null);
    expect(schoolTagOf('noreply+@urbanjungleirc.com')).toBe(null);
    expect(schoolTagOf(null)).toBe(null);
  });
});

describe('listSchools', () => {
  it('searches all three status views with the partial email filter', async () => {
    const client = clientWith({});
    await listSchools({ client });

    expect(client.calls.map(c => c.path)).toEqual(CONTACT_VIEWS);
    for (const call of client.calls) {
      expect(call.params.email).toBe(SCHOOL_EMAIL_PREFIX);
      expect(call.params.page_size).toBe(PAGE_SIZE);
    }
  });

  it('returns distinct tags with the address to write, and never a contact', async () => {
    const client = inOneView('members', [
      contact({ contact_key: 'a', email: 'noreply+newman@urbanjungleirc.com' }),
      contact({ contact_key: 'b', email: 'noreply+newman@urbanjungleirc.com' }),
      contact({ contact_key: 'c', email: 'noreply+scotch@urbanjungleirc.com' }),
    ]);
    const result = await listSchools({ client });

    expect(result.ok).toBe(true);
    expect(result.schools).toEqual([
      { tag: 'newman', email: 'noreply+newman@urbanjungleirc.com', contacts: 2 },
      { tag: 'scotch', email: 'noreply+scotch@urbanjungleirc.com', contacts: 1 },
    ]);
    expect(JSON.stringify(result)).not.toContain('Nowak');
    expect(JSON.stringify(result)).not.toContain('2009-03-02');
  });

  it('sorts tags alphabetically, because a picker is read not scanned', async () => {
    const client = inOneView('members', [
      contact({ contact_key: 'a', email: 'noreply+scotch@urbanjungleirc.com' }),
      contact({ contact_key: 'b', email: 'noreply+aquinas@urbanjungleirc.com' }),
    ]);
    const result = await listSchools({ client });
    expect(result.schools.map(s => s.tag)).toEqual(['aquinas', 'scotch']);
  });

  it('merges a tag seen across two views, and counts each contact once', async () => {
    const client = clientWith({
      members: [contact({ contact_key: 'a' })],
      prospects: [contact({ contact_key: 'b' })],
      // The same contact again, as a shifting page boundary would hand it back.
      non_attending_contacts: [contact({ contact_key: 'a' })],
    });
    const result = await listSchools({ client });

    expect(result.schools).toHaveLength(1);
    expect(result.schools[0].contacts).toBe(2);
  });

  it('ignores a row whose email carries no tag', async () => {
    const client = inOneView('members', [
      contact({ contact_key: 'a', email: 'noreply@urbanjungleirc.com' }),
      contact({ contact_key: 'b', email: null }),
      contact({ contact_key: 'c' }),
    ]);
    const result = await listSchools({ client });
    expect(result.schools.map(s => s.tag)).toEqual(['newman']);
  });

  it('pages a view past a full page', async () => {
    const client = inOneView('members', [
      filler(PAGE_SIZE),
      [contact({ contact_key: 'last', email: 'noreply+scotch@urbanjungleirc.com' })],
    ]);
    const result = await listSchools({ client });

    expect(result.schools.map(s => s.tag)).toEqual(['newman', 'scotch']);
    expect(result.truncated).toBe(false);
  });

  it('flags truncation when a view was still full at the ceiling', async () => {
    const client = inOneView('members', Array.from({ length: MAX_PAGES }, () => filler(PAGE_SIZE)));
    const result = await listSchools({ client });

    // Still an answer. Staff can always type a new tag, and a picker that
    // refused outright would block a school that is simply further down.
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.schools.map(s => s.tag)).toEqual(['newman']);
  });

  it('tells a throttle apart from every other upstream failure', async () => {
    const client = clientWith({}, { ok: false, status: 429, body: null, bodyText: 'slow down' });
    const result = await listSchools({ client });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('throttled');
    expect(result.upstreamStatus).toBe(429);
  });

  it('names the view that failed, so an operator knows what is missing', async () => {
    const client = clientWith({}, { ok: false, status: 500, body: null, message: 'boom' });
    const result = await listSchools({ client });

    expect(result.reason).toBe('upstream-error');
    expect(result.view).toBe('prospects');
  });

  it('refuses a 200 whose body is not a list of contacts', async () => {
    const client = clientWith({}, { body: { contacts: [] } });
    const result = await listSchools({ client });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('upstream-error');
  });

  it('counts every request it made', async () => {
    const client = clientWith({});
    const result = await listSchools({ client });
    expect(result.requests).toBe(CONTACT_VIEWS.length);
  });
});
