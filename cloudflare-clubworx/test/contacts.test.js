import { describe, it, expect } from 'vitest';
import { CONTACT_VIEWS, MAX_PAGES, PAGE_SIZE, searchContacts } from '../src/contacts.js';

// The dedup read, and the trap it exists to avoid.
//
// `/prospects`, `/members` and `/non_attending_contacts` are three **disjoint
// views by status**, not three indexes over one table (#49). A contact sits in
// exactly one and moves as their status changes, so a prospect-only lookup stops
// finding a student the moment they take a membership — which is not
// hypothetical: it broke the #60 probe when its own test contacts were
// converted. Every test below that looks redundant is guarding a way this search
// could quietly stop covering one of the three.
//
// The second theme is that **silence is the dangerous answer here**. A search
// that returns nothing reports the student as `new`, and `new` writes a contact
// that Clubworx cannot delete (ACCESS.md §4). So a failed view, an unreadable
// body and a sweep that never narrowed all refuse rather than answering with a
// short list.

const rows = {
  amelia: {
    contact_key: 'ck-amelia',
    first_name: 'Amelia',
    last_name: 'Nowak',
    dob: '2009-03-02',
    email: 'noreply+newman@urbanjungleirc.com',
    status: 'Prospect',
    phone: '0400 000 000',
    address: '1 Somewhere St',
  },
  twin: {
    contact_key: 'ck-twin',
    first_name: 'Julia',
    last_name: 'Nowak',
    dob: '2009-03-02',
    email: 'noreply+newman@urbanjungleirc.com',
    status: 'Member',
  },
};

/** A Clubworx client stub: one canned answer per view, plus a call recorder. */
function clientWith(byView) {
  const calls = [];
  return {
    calls,
    get: async (path, params) => {
      calls.push({ path, params });
      const answer = byView[path];
      const resolved = typeof answer === 'function' ? answer(params) : answer;
      return {
        ok: true,
        status: 200,
        url: `https://app.clubworx.com/api/v2/${path}`,
        ms: 1,
        body: [],
        nonJson: false,
        bodyText: null,
        message: null,
        networkError: false,
        ...(resolved ?? {}),
      };
    },
  };
}

/** Every view answers with the same empty list. */
const emptyEverywhere = () => clientWith(Object.fromEntries(CONTACT_VIEWS.map(v => [v, { body: [] }])));

const search = (client, over = {}) =>
  searchContacts({ client, lastName: 'Nowak', dob: '2009-03-02', ...over });

describe('the three status views', () => {
  it('names all three, in the order #49 measured them', () => {
    expect(CONTACT_VIEWS).toEqual(['prospects', 'members', 'non_attending_contacts']);
  });

  it('searches every one of them, not just prospects', async () => {
    const client = emptyEverywhere();
    await search(client);

    expect(client.calls.map(c => c.path)).toEqual(CONTACT_VIEWS);
  });

  it('finds a student who has since become a member', async () => {
    // The #60 failure exactly: the contact was created as a prospect, somebody
    // converted it, and a prospect-only lookup went blind.
    const client = clientWith({ prospects: { body: [] }, members: { body: [rows.amelia] } });
    const result = await search(client);

    expect(result.ok).toBe(true);
    expect(result.candidates.map(c => c.contact_key)).toEqual(['ck-amelia']);
  });

  it('finds a student parked in non_attending_contacts', async () => {
    const client = clientWith({ non_attending_contacts: { body: [rows.amelia] } });
    const result = await search(client);

    expect(result.candidates.map(c => c.contact_key)).toEqual(['ck-amelia']);
  });

  it('records which view held each contact, so a duplicate can be explained', async () => {
    const client = clientWith({ members: { body: [rows.amelia] } });
    const [candidate] = (await search(client)).candidates;

    expect(candidate.status_view).toBe('members');
  });
});

describe('the query', () => {
  it('asks on surname and date of birth — the candidate-narrowing key of §5', async () => {
    const client = emptyEverywhere();
    await search(client);

    expect(client.calls[0].params).toMatchObject({ last_name: 'Nowak', dob: '2009-03-02' });
  });

  it('always sends a page size, because the default 50 is silent truncation (#51)', async () => {
    const client = emptyEverywhere();
    await search(client);

    for (const call of client.calls) expect(call.params.page_size).toBe(PAGE_SIZE);
  });

  it('starts at page 1 and does not page a view that came back short', async () => {
    const client = clientWith({ prospects: { body: [rows.amelia] } });
    await search(client);

    expect(client.calls[0].params.page).toBe(1);
    expect(client.calls.filter(c => c.path === 'prospects')).toHaveLength(1);
  });

  it('costs three requests for a student found on the first page of each view', async () => {
    // The ticket's budget: 3 reads per student, so a 25-student list spends ~75
    // requests here alone. A fourth request per student would be a 33% run.
    const client = emptyEverywhere();
    expect((await search(client)).requests).toBe(3);
  });
});

describe('paging to exhaustion', () => {
  /** A view that answers `total` rows across pages of `PAGE_SIZE`. */
  const pagedView = total => params => {
    const page = Number(params.page);
    const from = (page - 1) * PAGE_SIZE;
    const body = Array.from({ length: Math.max(0, Math.min(PAGE_SIZE, total - from)) }, (_, i) => ({
      ...rows.amelia,
      contact_key: `ck-${from + i}`,
    }));
    return { body };
  };

  it('fetches the next page when one comes back full — a full page is not a complete list', async () => {
    const client = clientWith({ prospects: pagedView(PAGE_SIZE + 3) });
    const result = await search(client);

    expect(client.calls.filter(c => c.path === 'prospects').map(c => c.params.page)).toEqual([1, 2]);
    expect(result.candidates).toHaveLength(PAGE_SIZE + 3);
  });

  it('stops at the first short page rather than walking to an empty one', async () => {
    const client = clientWith({ prospects: pagedView(PAGE_SIZE + 3) });
    await search(client);

    // Page 2 came back short, so page 3 is a request that buys nothing and
    // spends a gym-wide allowance the roster Worker is also drawing on.
    expect(client.calls.filter(c => c.path === 'prospects')).toHaveLength(2);
  });

  it('stops when an exactly-full last page is followed by an empty one', async () => {
    const client = clientWith({ prospects: pagedView(PAGE_SIZE) });
    const result = await search(client);

    expect(client.calls.filter(c => c.path === 'prospects').map(c => c.params.page)).toEqual([1, 2]);
    expect(result.candidates).toHaveLength(PAGE_SIZE);
  });

  it('de-duplicates rows a shifting page boundary showed twice', async () => {
    const client = clientWith({
      prospects: params => ({ body: Number(params.page) === 1 ? Array(PAGE_SIZE).fill(rows.amelia) : [rows.amelia] }),
    });

    expect((await search(client)).candidates).toHaveLength(1);
  });

  it('de-duplicates by contact_key across the three views', async () => {
    // A contact that moves mid-search can be seen twice. Merging is by key, not
    // by position — #68 says de-duplicate by `contact_key`.
    const client = clientWith({ prospects: { body: [rows.amelia] }, members: { body: [rows.amelia] } });

    expect((await search(client)).candidates).toHaveLength(1);
  });

  it('drops a row with no contact_key rather than merging it under undefined', async () => {
    const client = clientWith({ prospects: { body: [{ ...rows.amelia, contact_key: undefined }] } });

    expect((await search(client)).candidates).toEqual([]);
  });
});

describe('a sweep that never narrowed', () => {
  const alwaysFull = () => ({ body: Array.from({ length: PAGE_SIZE }, (_, i) => ({ ...rows.amelia, contact_key: `ck-${i}` })) });

  it('refuses rather than answering from a truncated sweep', async () => {
    // Whether Clubworx honours a `last_name` filter server-side is unmeasured.
    // If it does not, this is a walk through a 60,000-person database — and the
    // rows it returns are strangers. Refusing is what stops that answer being
    // mistaken for a narrow one.
    const client = clientWith({ prospects: alwaysFull });
    const result = await search(client);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('search-not-narrowed');
    expect(result.view).toBe('prospects');
  });

  it('bounds the walk instead of paging a whole gym database', async () => {
    const client = clientWith({ prospects: alwaysFull });
    await search(client);

    expect(client.calls.filter(c => c.path === 'prospects')).toHaveLength(MAX_PAGES);
  });

  it('stops the whole search at the first view that would not narrow', async () => {
    const client = clientWith({ prospects: alwaysFull });
    await search(client);

    expect(client.calls.every(c => c.path === 'prospects')).toBe(true);
  });
});

describe('when a view fails', () => {
  it('refuses the whole search rather than answering from two views out of three', async () => {
    // A partial answer is the #49 trap wearing a different hat: the missing view
    // is exactly where the student might be, and a short candidate set reports
    // them `new`. `new` writes a contact that cannot be deleted.
    const client = clientWith({
      prospects: { body: [] },
      members: { ok: false, status: 500, body: null, message: 'Internal Server Error' },
    });
    const result = await search(client);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('upstream-error');
    expect(result.view).toBe('members');
    expect(result.upstreamStatus).toBe(500);
  });

  it('stops calling the remaining views once one has failed', async () => {
    const client = clientWith({ prospects: { ok: false, status: 500, body: null } });
    await search(client);

    expect(client.calls).toHaveLength(1);
  });

  it('tells a throttle apart from every other failure, because a 429 pauses the run', async () => {
    const client = clientWith({ prospects: { ok: false, status: 429, body: null } });
    const result = await search(client);

    expect(result.reason).toBe('throttled');
    expect(result.upstreamStatus).toBe(429);
  });

  it('treats a connection failure as a failure, not as an empty view', async () => {
    const client = clientWith({
      prospects: { ok: false, status: 0, body: null, networkError: true, message: 'fetch failed' },
    });
    const result = await search(client);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('upstream-error');
  });

  it('refuses a 200 whose body is not a list, rather than reading it as zero rows', async () => {
    // Measured: these endpoints answer with a bare array. Anything else is a
    // response nobody has seen, and "no rows" is the one wrong guess that ends
    // in a permanent duplicate contact.
    const client = clientWith({ prospects: { ok: true, status: 200, body: { contacts: [] } } });
    const result = await search(client);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('upstream-error');
  });

  it('carries the upstream message through unchanged, never re-worded (D6)', async () => {
    const client = clientWith({
      prospects: { ok: false, status: 400, body: null, message: "Woops! Something you've not seen before" },
    });

    expect((await search(client)).message).toContain("Woops! Something you've not seen before");
  });
});

describe('what a candidate carries', () => {
  it('carries the four fields the match rule reads', async () => {
    const client = clientWith({ prospects: { body: [rows.amelia] } });
    const [candidate] = (await search(client)).candidates;

    // school-booking/identity.js matches on these and nothing else.
    expect(candidate).toMatchObject({
      contact_key: 'ck-amelia',
      first_name: 'Amelia',
      last_name: 'Nowak',
      dob: '2009-03-02',
    });
  });

  it('carries the email, because the noreply+<school> tag is the only provenance there is', async () => {
    const client = clientWith({ prospects: { body: [rows.amelia] } });
    const [candidate] = (await search(client)).candidates;

    expect(candidate.email).toBe('noreply+newman@urbanjungleirc.com');
  });

  it('leaves behind the fields nothing here asks a question of', async () => {
    // The Worker is a transit (§6, D10). A phone number and a home address are
    // not part of deciding whether this student already exists, so they do not
    // travel to the browser.
    const client = clientWith({ prospects: { body: [rows.amelia] } });
    const [candidate] = (await search(client)).candidates;

    expect(candidate.phone).toBeUndefined();
    expect(candidate.address).toBeUndefined();
  });
});

describe('what it refuses to decide', () => {
  it('returns both twins rather than picking one', async () => {
    // The match state is produced by the pure school-booking/identity.js module,
    // which stays network-free so it stays testable. This route narrows; it does
    // not conclude.
    const client = clientWith({ prospects: { body: [rows.amelia, rows.twin] } });
    const result = await search(client);

    expect(result.candidates.map(c => c.contact_key).sort()).toEqual(['ck-amelia', 'ck-twin']);
  });

  it('does not drop a candidate whose dob came back blank', async () => {
    // A contact created by hand often carries no DOB (#49). identity.js has a
    // `candidate-dob-unknown` state for exactly this row; filtering it out here
    // would report an existing student as `new`.
    const client = clientWith({ prospects: { body: [{ ...rows.amelia, dob: '' }] } });

    expect((await search(client)).candidates).toHaveLength(1);
  });

  it('answers an empty candidate set plainly when nothing was found', async () => {
    const result = await search(emptyEverywhere());

    expect(result.ok).toBe(true);
    expect(result.candidates).toEqual([]);
  });
});
