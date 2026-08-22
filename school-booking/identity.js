// school-booking/identity.js
//
// The matching rule: given one parsed student row and the Clubworx contacts a
// search returned for them, decide whether this student is `new`, `matched`, a
// `name-variant` or `ambiguous`. Pure on purpose — no DOM, no network, no clock.
// The page imports this and publishes it as `window.schoolIdentity`, the same
// seam parse.js, delete-logic.js and unsubscribes-logic.js use.
//
// Rules are §5 of docs/superpowers/specs/2026-08-19-school-group-booking-design.md.
// Vocabulary is CONTEXT.md § "Clubworx school list parsing".
//
// **It does not fetch the candidates.** That is the Worker's job — it searches
// all three disjoint status views (#49) and merges. Keeping this module
// network-free is what makes the rule testable.
//
// ---------------------------------------------------------------------------
// The two normalisations are imported, never restated
// ---------------------------------------------------------------------------
// `writeForm` and `compareForm` live in parse.js, which shipped first: P10
// requires the parser to emit both forms for every row, and P14's in-paste dedup
// needs compare form to tell a true duplicate from twins. Two copies of that
// table would drift, and the drift is silent in the worst way — the day compare
// form disagrees with itself, `O'Brien` stops matching `OBrien`, a student who
// already has a contact comes back as `new`, and a second permanent contact is
// written for them. Nothing throws: both spellings are individually valid, and
// contacts cannot be deleted.
import { compareForm } from './parse.js?v=4';

// ---------------------------------------------------------------------------
// Match states (P2b)
// ---------------------------------------------------------------------------
// The match states — `new` / `matched` / `name-variant` / `ambiguous`, and
// `already booked`, which belongs to the booking pass rather than to this module
// — are distinct from the parse states `clean` / `needs-confirmation` / `error` /
// `ignored`, which exist before any API call. §9's preview table gives each axis
// its own column for exactly that reason.
//
// `unmatchable` is a sixth, added on #65 and recorded in CONTEXT.md § "Parse-time
// row state": a row missing either half of the identity key can conclude nothing,
// and the five states above have no way to say so. See the guard in
// `matchStudent` for why silence is not an option.

// An absent DOB and an empty one are the same fact, and both arrive: the parser
// emits `null` when it could not read a date, Clubworx omits the field on some
// rows and returns it blank on others.
function dobOf(value) {
  const s = String(value ?? '').trim();
  return s || null;
}

/**
 * Decide the match state for one student row against one candidate set.
 *
 * `contact` is populated **only** when the state is `matched`. A `name-variant`
 * or `ambiguous` row carries its possibilities in `candidates` instead, so a
 * caller that writes `if (match.contact) reuse(match.contact)` cannot
 * accidentally accept a variance a human has not looked at.
 *
 * `reason` is the controlled vocabulary behind whatever the review table ends up
 * saying, and it stays factual — what happened, not how to word it:
 *
 * | `state` | `reason` |
 * |---|---|
 * | `unmatchable` | `no-dob`, `no-surname` |
 * | `new` | `no-candidates` |
 * | `matched` | `first-name-matches` |
 * | `name-variant` | `first-name-differs` |
 * | `ambiguous` | `no-first-name-match`, `duplicate-contacts`, `candidate-dob-unknown` |
 *
 * `firstNameIsPreferred` is echoed onto every result rather than folded into
 * `reason`, because it is a second, independent fact: the reason says the names
 * disagree, and this says a disagreement was expected. Collapsing them would cost
 * the difference between twins-with-nicknames and a plain duplicate.
 *
 * @param {{write: {firstName: string, lastName: string, dob: string|null},
 *          compare: {firstName: string, lastName: string}}} record
 *        A row as `parseStudentList` emits it.
 * @param {Array<{contact_key: string, first_name?: string, last_name?: string, dob?: string}>} candidates
 *        What the Worker's three-view search returned. Tolerates a missing list:
 *        it arrives as a field of a fetch response, not as a local literal.
 * @param {{firstNameIsPreferred?: boolean}|null} [columns]
 *        `parseStudentList`'s `columns`, passed straight through — the whole
 *        object rather than a hand-copied boolean, because the two always travel
 *        together and a forgotten flag reads a nickname list as a name mismatch.
 *        `columns` is `null` on the parser's refusal paths, hence the optional
 *        chaining. Only `firstNameIsPreferred` is read: true when the school's
 *        own header called the column a preferred name, which is the only place
 *        that distinction survives from the paste.
 */
export function matchStudent(record, candidates = [], columns = null) {
  const firstNameIsPreferred = columns?.firstNameIsPreferred === true;
  const dob = dobOf(record?.write?.dob);
  const lastName = record?.compare?.lastName ?? '';
  const firstName = record?.compare?.firstName ?? '';

  const outcome = ({ state, reason, contact = null, candidates: offered = [] }) => ({
    state,
    reason,
    contact,
    candidates: offered,
    firstNameIsPreferred,
  });

  // Both halves of the identity key are required before anything can be concluded
  // from any candidate set, and the parser can emit a row missing either: a `null`
  // dob when no date could be read, an empty surname for an unsplittable
  // single-token name. It holds both at needs-confirmation, and the step-4 gates
  // should mean neither arrives here — this refuses rather than trusting them,
  // because being wrong costs a write that cannot be undone.
  //
  // Reporting `new` for a DOB-less row creates a permanent contact with no DOB,
  // which then poisons the surname + DOB key for every later term — the same
  // damage a wrong date orientation does (CONTEXT.md § Date orientation).
  // Matching a surname-less row picks whichever contact shares the birthday.
  if (!dob) {
    return outcome({ state: 'unmatchable', reason: 'no-dob' });
  }
  if (!lastName) {
    return outcome({ state: 'unmatchable', reason: 'no-surname' });
  }

  // Surname + DOB narrows. Re-checked here rather than trusted from the query:
  // whether Clubworx honours a `dob` filter server-side is unmeasured, and a
  // candidate that slipped through must not be matched on surname alone.
  const bySurname = (Array.isArray(candidates) ? candidates : []).filter(
    (row) => compareForm(row?.last_name) === lastName
  );
  const narrowed = bySurname.filter((row) => dobOf(row?.dob) === dob);

  if (narrowed.length === 0) {
    // A contact created by hand often carries no DOB at all, and #49 measured that
    // the field can come back empty. Such a row cannot be confirmed — but
    // discarding it reports a student who already exists as `new` and writes them
    // a second permanent contact, so a same-name one is surfaced instead of
    // dropped. The first name is required here precisely because surname alone is
    // not an identity: a school list holds siblings.
    //
    // Deliberately only when nothing was confirmed. With a DOB-confirmed
    // candidate in hand this branch would add noise, not safety: the run reuses
    // the better-identified record and creates nothing, so no second contact can
    // come of it.
    const dobUnknown = bySurname.filter(
      (row) => !dobOf(row?.dob) && compareForm(row?.first_name) === firstName
    );
    if (dobUnknown.length > 0) {
      return outcome({
        state: 'ambiguous',
        reason: 'candidate-dob-unknown',
        candidates: dobUnknown,
      });
    }
    return outcome({ state: 'new', reason: 'no-candidates' });
  }

  // First name breaks ties — twins share both surname and birthday.
  const byFirstName = narrowed.filter((row) => compareForm(row?.first_name) === firstName);

  if (byFirstName.length === 1) {
    return outcome({
      state: 'matched',
      reason: 'first-name-matches',
      contact: byFirstName[0],
      candidates: narrowed,
    });
  }

  // One candidate, a different first name. Katie/Katherine is a human decision,
  // and so is the `PreferredName` case, where a mismatch is the *correct* outcome
  // of a correct match — one real list ships a nickname column. Never merged
  // either way; `firstNameIsPreferred` on the result is what lets the operator be
  // told which of the two they are looking at.
  if (narrowed.length === 1) {
    return outcome({ state: 'name-variant', reason: 'first-name-differs', candidates: narrowed });
  }

  // Two contacts with the same name and birthday. Contacts cannot be deleted
  // through the API, so a ~60,000-person database holds duplicates; taking the
  // first would attach a permanent pass to whichever row the search happened to
  // return first, which is not a decision this module gets to make.
  if (byFirstName.length > 1) {
    return outcome({ state: 'ambiguous', reason: 'duplicate-contacts', candidates: narrowed });
  }

  // Twins already in Clubworx, and the paste's first name matches neither. Kept
  // distinct from `duplicate-contacts` because the two need different resolutions:
  // one is a choice between records, the other a choice between children.
  return outcome({ state: 'ambiguous', reason: 'no-first-name-match', candidates: narrowed });
}
