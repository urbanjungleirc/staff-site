/**
 * Who a write probe is allowed to be, and what it is allowed to create.
 *
 * Clubworx has no sandbox and **cannot delete a contact through the API**
 * (ACCESS.md section 4). Every contact a probe writes is permanent, lives
 * beside ~60,000 real people, and can only be removed by hand in the Clubworx
 * UI. So the identity is not a fixture detail — it is the blast radius, and
 * `assertProbeIdentity` is the control that keeps it that size.
 *
 * Each set below is deliberately the *smallest* one that can answer its ticket
 * — `PROBE_CONTACTS` for staff-site#49, `MEMBER_PROBE_CONTACTS` for #63. Adding
 * to either is a decision to leave more permanent records in a production
 * database, not a refactor, and each set carries its own authorisation in
 * ACCESS.md section 4.
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

/**
 * The two contacts staff-site#63 needs, and why there are two.
 *
 * **This is a new authorisation, not a reuse of #49's.** ACCESS.md section 4
 * says the three-contact amendment is *spent* — *"A fourth contact is a new
 * decision"* — and #63 cannot borrow those three: every one of them already
 * exists, and the question is what `POST /api/v2/members` does when it
 * *creates* one. There is no way to ask that of a contact that is already
 * there.
 *
 * Two is the minimum that answers all four of #63's questions, for the same
 * structural reason #49 needed three rather than one:
 *
 *   - **D** is created with only the four required fields. That is question 1
 *     on its own — does the endpoint work at all — and, once it is given a pass
 *     through the *measured* two-call route, question 2: is a contact made this
 *     way bookable.
 *   - **E** is created with `membership_plan_id` in the same call. That is
 *     questions 3 and 4, and it cannot be folded into D: the plan has to ride
 *     along on the **create**, so testing it needs a contact that does not yet
 *     exist.
 *
 * Folding them into one contact would answer either 1 and 2, or 3 and 4, and
 * leave the other pair resting on the reference — which is the exact thing #63
 * exists to stop, the reference having been wrong twice on this map already.
 *
 * They reuse #49's plus-tag deliberately. A third tag would be a new search
 * surface every later probe has to sweep, and #49 already settled that a tag
 * isolates.
 *
 * Both are **permanent**. The probe creates E only if D's create is seen to
 * work, so a `POST /members` that turns out to be refused costs one contact
 * rather than two.
 */
export const MEMBER_PROBE_CONTACTS = [
  {
    label: 'D',
    first_name: 'Ztest',
    last_name: 'Wayfinderfour',
    dob: PROBE_DOB,
    email: TEST_IDENTITY.email,
    why: 'plain create — does POST /members work, and is the result bookable with a pass? (Q1, Q2)',
  },
  {
    label: 'E',
    first_name: 'Ztest',
    last_name: 'Wayfinderfive',
    dob: PROBE_DOB,
    email: TEST_IDENTITY.email,
    // The id itself is resolved by name at run time and deliberately not
    // declared here — #60 watched `GET /membership_plans` truncate at 50 and
    // hide this very plan, so a hard-coded id is a guess nobody can check
    // against the Clubworx UI.
    withPlanOnCreate: true,
    why: 'create with membership_plan_id — does the pass ride along, and what start_date does it get? (Q3, Q4)',
  },
];
