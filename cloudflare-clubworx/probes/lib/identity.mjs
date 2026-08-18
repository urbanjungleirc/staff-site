/**
 * Who a write probe is allowed to be, and what it is allowed to create.
 *
 * Clubworx has no sandbox and **cannot delete a contact through the API**
 * (ACCESS.md section 4). Every contact a probe writes is permanent, lives
 * beside ~60,000 real people, and can only be removed by hand in the Clubworx
 * UI. So the identity is not a fixture detail — it is the blast radius, and
 * `assertProbeIdentity` is the control that keeps it that size.
 *
 * The set below is deliberately the *smallest* one that can answer
 * staff-site#49. Adding to it is a decision to leave more permanent records in
 * a production database, not a refactor.
 */

/** The identity ACCESS.md section 4 agreed, 2026-08-17. */
export const TEST_IDENTITY = {
  first_name: 'Ztest',
  last_name: 'Wayfinder',
  dob: '1900-01-01',
  email: 'noreply+wayfindertest@urbanjungleirc.com',
};

const SECOND_TAG_EMAIL = 'noreply+wayfindertestb@urbanjungleirc.com';

/**
 * The three contacts #49 needs, and why each one exists.
 *
 * ACCESS.md section 4 authorised *one* identity. #49 cannot be answered with
 * one: question 2 asks whether many contacts may share an email, and question 3
 * asks whether a tag *isolates* a school — an exclusion needs something to
 * exclude. Three contacts, authorised 2026-08-17, is the minimum that answers
 * all four questions. Every one of them is permanent.
 */
export const PROBE_CONTACTS = [
  {
    label: 'A',
    ...TEST_IDENTITY,
    why: 'baseline — does POST accept a plus-addressed noreply@ at all? (Q1)',
  },
  {
    label: 'B',
    first_name: 'Ztest',
    last_name: 'Wayfindertwo',
    dob: '1900-01-01',
    email: TEST_IDENTITY.email,
    why: 'same email as A, different surname — the sibling case (Q2)',
  },
  {
    label: 'C',
    first_name: 'Ztest',
    last_name: 'Wayfinderthree',
    dob: '1900-01-01',
    email: SECOND_TAG_EMAIL,
    why: 'a second plus-tag, so the isolation query has something to exclude (Q3)',
  },
];

/** The probe email shape. Anything outside it is refused, not normalised. */
const PROBE_EMAIL = /^noreply\+wayfindertest[a-z]*@urbanjungleirc\.com$/;
const PROBE_DOB = '1900-01-01';

/**
 * Refuse to write anything that is not the agreed test identity.
 *
 * This sits in front of the only POST path (`lib/write.mjs`), so "a probe
 * cannot create a contact that looks like a real person" is a property of the
 * code rather than a promise in a comment — the same reason `lib/http.mjs` can
 * only issue GET. It matters more here than there: a mistaken read costs
 * nothing, and a mistaken write cannot be undone.
 *
 * @param {{first_name?: string, last_name?: string, dob?: string, email?: string}} contact
 */
export function assertProbeIdentity(contact) {
  const { first_name, last_name, dob, email } = contact ?? {};

  if (first_name !== 'Ztest') {
    throw new Error(
      `refusing to write a contact whose first name is not Ztest (got ${JSON.stringify(first_name)}) — ` +
        'contacts created here are permanent',
    );
  }
  if (typeof last_name !== 'string' || !last_name.startsWith('Wayfinder')) {
    throw new Error(
      `refusing to write a contact outside the Wayfinder family (got ${JSON.stringify(last_name)})`,
    );
  }
  if (dob !== PROBE_DOB) {
    throw new Error(`refusing to write a contact with a plausible dob (got ${JSON.stringify(dob)})`);
  }
  if (typeof email !== 'string' || !PROBE_EMAIL.test(email)) {
    throw new Error(
      `refusing to write a contact whose email is not a noreply+ probe address (got ${JSON.stringify(email)})`,
    );
  }

  return contact;
}

/**
 * Read the tag out of a plus-addressed email.
 *
 * @param {string} email
 * @returns {string|null}
 */
export function plusTag(email) {
  const match = /^[^+@]+\+([^@]+)@/.exec(String(email ?? ''));
  return match ? match[1] : null;
}

/**
 * Is this row one the probe wrote?
 *
 * Deliberately weaker than `assertProbeIdentity`, and the difference is
 * load-bearing. A *write* must satisfy all four fields — that is the blast
 * radius control. A *read* is matched on name and email only, because a list
 * response is not guaranteed to carry a date of birth, and a recogniser that
 * demanded one would fail to see the probe's own contacts and create three more
 * permanent records on every run. The failure modes are asymmetric: being too
 * strict here is what leaves litter behind.
 *
 * @param {{first_name?: string, last_name?: string, email?: string}} row
 */
export function isProbeRow(row) {
  const { first_name, last_name, email } = row ?? {};
  return (
    first_name === 'Ztest' &&
    typeof last_name === 'string' &&
    last_name.startsWith('Wayfinder') &&
    typeof email === 'string' &&
    PROBE_EMAIL.test(email)
  );
}

/**
 * Keep only the rows this probe could have written, and only three fields of them.
 *
 * The search that feeds `planContacts` is a partial email match against a
 * 60,000-person production database, so it returns strangers. Dropping them here
 * — before anything is planned, printed or written to `probes/out/` — is what
 * keeps the promise `summariseContacts` makes on the reporting path. A row is
 * kept only if it passes the same identity guard a write would.
 *
 * @param {unknown} body
 * @returns {Array<{contact_key: string, email: string, last_name: string}>}
 */
export function pickProbeRows(body) {
  if (!Array.isArray(body)) return [];

  return body
    .filter(isProbeRow)
    .map(row => ({
      contact_key: row.contact_key,
      email: row.email,
      last_name: row.last_name,
    }));
}

/**
 * Decide what still needs creating, given what a search already found.
 *
 * ACCESS.md: *"Search first. If `Ztest Wayfinder` already exists from an
 * earlier run, reuse it rather than creating a second — the identity is only a
 * blast-radius control if there is exactly one of it."* A second run of this
 * probe must therefore cost nothing permanent.
 *
 * Matching is on **email and surname together**. Email alone would see B as
 * already present the moment A exists — they share an address on purpose — and
 * question 2 would silently never be asked.
 *
 * @param {object} opts
 * @param {Array<object>} opts.wanted   Contacts from PROBE_CONTACTS.
 * @param {Array<{contact_key: string, email?: string, last_name?: string}>} opts.existing
 * @returns {{create: Array<object>, reuse: Array<object>}}
 */
export function planContacts({ wanted, existing = [] }) {
  const create = [];
  const reuse = [];

  for (const contact of wanted) {
    const found = existing.find(
      row => row?.email === contact.email && row?.last_name === contact.last_name,
    );
    if (found) {
      reuse.push({ ...contact, contact_key: found.contact_key });
    } else {
      create.push(contact);
    }
  }

  return { create, reuse };
}
