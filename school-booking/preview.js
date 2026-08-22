// school-booking/preview.js
//
// Step 5 — the preview table, the permanence line, and the hard-stops that keep
// Apply dark. A pure module over what steps 3 and 4 produced plus the Clubworx
// check between them; the page publishes it as `window.schoolBookingPreview`.
//
// staff-site#72. Design: `docs/superpowers/specs/2026-08-19-school-group-booking-design.md`
// §9 (the preview table, where the per-row consequence lives), §11 (the
// refusals), §12 (irreversibility).
//
// ---------------------------------------------------------------------------
// Three columns, because there are three state axes
// ---------------------------------------------------------------------------
// `READ` is the parse state and `CLUBWORX` the match state — P2b's separation
// made **structural** rather than folded into the student cell as a pill.
// Reading *down* a column is how you spot that every row is `clean` but three
// are `new`, which is the scan this screen exists for.
//
// ---------------------------------------------------------------------------
// What this screen does NOT know, and says so
// ---------------------------------------------------------------------------
// §9's sketch of the expanded row reads *"create nothing · pass already active ·
// 4 bookings (2 already booked)"*. Two thirds of that sentence is not knowable
// here, and the module says the knowable part instead:
//
//   - **The pass.** D4 reads the membership only for matched contacts, and D14
//     re-reads it **at Apply, immediately before its own write**, because
//     preview reads go stale and the membership is the one write with no
//     server-side idempotency. §6's route table has no read-only membership
//     route at all. So a matched row says *pass checked at Apply* — the true
//     statement — rather than *pass already active*, which nothing checked.
//   - **Already-booked bookings.** Booking idempotency is Clubworx refusing the
//     duplicate at write time (D5); there is no bookings read on the Worker.
//     The count of bookings a student would be *offered* is known; how many of
//     them already exist is not, until §12's result table says it in past tense.
//
// The alternative — showing the sentence §9 sketches and filling it from
// nothing — is the failure mode #50 is the cautionary tale for: a
// truthful-sounding line pointed at entirely the wrong mechanism.
//
// The permanence line above the table carries the same honesty: new students
// are counted exactly, and returning students are named as a pass that has not
// been settled rather than folded into the total either way.

const plural = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;
// "School Pass" does not take a bare -s, and it is the noun this line is most
// about. Spelled here rather than patched after the fact.
const passes = (n) => `${n} School ${n === 1 ? 'Pass' : 'Passes'}`;

// Why a row cannot run, in the words staff would use. Every state
// `matchStudent` can return that is not `new` or `matched` has a line here: a
// row that blocks the run without saying why is a row that gets resolved the
// quickest way rather than the right way.
const MATCH_NOTES = {
  'no-dob': 'No date of birth, so this student cannot be told apart from anyone else with '
    + 'their surname. Go back and fix the row.',
  'no-surname': 'No surname, so there is no identity to search on. Go back and fix the row.',
  'first-name-differs': 'A contact matches the surname and birthday but not the first name. '
    + 'Katie and Katherine are the same child; two children are not.',
  'duplicate-contacts': 'Clubworx holds more than one contact with this name and birthday. '
    + 'Contacts cannot be deleted, so which one gets the pass is not a guess this page makes.',
  'no-first-name-match': 'Two contacts share this surname and birthday and neither first name '
    + 'matches — siblings, probably twins. Pick the right child or create a new contact.',
  'candidate-dob-unknown': 'A contact with this exact name has no birthday recorded, so it '
    + 'cannot be confirmed or ruled out. Creating a new one risks a permanent duplicate.',
};

const PREFERRED_NAME_NOTE = ' The school listed a preferred name column, so a first-name '
  + 'mismatch here is what a correct match looks like.';

/** The states a row can be resolved out of. `unmatchable` is not one of them — see below. */
const RESOLVABLE = new Set(['name-variant', 'ambiguous']);

/**
 * Record — or take back — one match decision.
 *
 * A simpler log than step 3's: there is no gate here asking *did staff work the
 * rows*, so a decision taken back leaves nothing behind. Returns a new object,
 * because Alpine re-renders from the returned value and a mutated original
 * would make an undo unobservable.
 *
 * @param {object} decisions the current log, keyed by row key
 * @param {number|string} key the row's key, as step 3 assigned it
 * @param {{kind: 'use', contactKey: string}|{kind: 'create'}|null} action
 */
export function resolveMatch(decisions, key, action) {
  const next = { ...(decisions ?? {}) };
  if (action === null || action === undefined) delete next[key];
  else next[key] = action;
  return next;
}

/** The decision in force on a row, or null. */
export function matchDecision(decisions, key) {
  return (decisions ?? {})[key] ?? null;
}

/**
 * Apply a decision to a match result.
 *
 * A `use` naming a contact the current candidate list does not hold is
 * **ignored**. The check re-runs whenever staff go back and forth, and a
 * decision that outlived its candidates would attach a permanent pass to a
 * contact key nothing on screen ever showed.
 *
 * `unmatchable` is deliberately not resolvable. It means the identity key
 * itself is missing — no date of birth, or no surname — so there is nothing to
 * decide *between*: choosing a contact would be choosing on a birthday alone,
 * and creating one writes a permanent record that then poisons the surname +
 * DOB key for every later term. The fix is back on step 3, on the row.
 */
function decided(result, decision) {
  if (!decision || !RESOLVABLE.has(result.state)) return { result, applied: null };

  if (decision.kind === 'create') {
    return { result: { ...result, state: 'new', contact: null }, applied: 'create' };
  }

  if (decision.kind === 'use') {
    const hit = (result.candidates ?? []).find((c) => String(c?.contact_key) === String(decision.contactKey));
    if (!hit) return { result, applied: null };
    return { result: { ...result, state: 'matched', contact: hit }, applied: 'use' };
  }

  return { result, applied: null };
}

/**
 * One preview row: the three state cells, the outcome, and everything the
 * expanded row needs.
 */
function previewRow(source, rawMatch, decision, sessions) {
  const name = [source.firstName, source.lastName].filter(Boolean).join(' ').trim();
  const base = {
    key: source.key,
    lineNumbers: [...(source.lineNumbers ?? [])],
    name: name || '(no name)',
    dob: source.dob ?? null,
    read: source.state,
    sessions,
    candidates: [],
    contactKey: null,
    resolution: null,
    firstNameIsPreferred: false,
  };

  // A row step 3 has not settled was never sent to the search, and its cell is
  // empty rather than guessing. Sending a row with a wrong or missing date of
  // birth is how the identity key gets poisoned permanently.
  if (source.needsHuman) {
    return { ...base, clubworx: '', outcome: 'blocked', needsHuman: true, note: source.note ?? '' };
  }

  if (!rawMatch) {
    // Absent is not `new`. `new` writes a permanent contact, and doing that on
    // the strength of a request nobody made is a duplicate with no cause.
    return {
      ...base,
      clubworx: 'pending',
      outcome: 'blocked',
      needsHuman: true,
      note: 'Clubworx has not been checked for this student yet.',
    };
  }

  if (rawMatch.error) {
    return {
      ...base,
      clubworx: 'error',
      outcome: 'blocked',
      needsHuman: true,
      // Verbatim, attributed, never re-worded — D6.
      note: rawMatch.error,
    };
  }

  const { result, applied } = decided(rawMatch, decision);
  const preferred = result.firstNameIsPreferred === true;
  const note = (MATCH_NOTES[result.reason] ?? '') + (preferred && result.state !== 'matched' ? PREFERRED_NAME_NOTE : '');

  const common = {
    ...base,
    clubworx: result.state,
    candidates: [...(result.candidates ?? [])],
    resolution: applied,
    firstNameIsPreferred: preferred,
  };

  if (result.state === 'new') {
    return { ...common, outcome: `will book ×${sessions}`, needsHuman: false, note: applied === 'create' ? note : '' };
  }

  if (result.state === 'matched') {
    return {
      ...common,
      outcome: `will book ×${sessions}`,
      needsHuman: false,
      note: '',
      contactKey: result.contact?.contact_key ?? null,
    };
  }

  return { ...common, outcome: 'blocked', needsHuman: true, note };
}

/**
 * The per-row consequence, in full. It lives in the **expanded row** — the
 * aggregate line above the table is what staff read to approve the run, and a
 * permanence sentence repeated on 63 rows is the repetition that trains people
 * to stop reading a region (§9, and P9's argument against struck-through junk).
 */
export function consequenceLine(previewed) {
  if (!previewed) return '';
  if (previewed.outcome === 'blocked') return previewed.note || 'This row will not run.';

  const bookings = `${plural(previewed.sessions, 'booking')} (cancellable)`;
  if (previewed.clubworx === 'new') {
    return `create a contact (permanent) · grant a School Pass (permanent) · ${bookings}`;
  }
  // See the header: the membership is read at Apply (D14), so this is what is
  // actually known here.
  return `create nothing · pass checked at Apply · ${bookings}`;
}

/**
 * The run's whole consequence, above the table.
 *
 * Preview and result are the same line in two tenses (D11), so this is the
 * future-tense half; #73 writes the past-tense one over the same rows. The
 * three permanence classes stay separate rather than collapsing into a success
 * count, because they are three different kinds of irreversible.
 */
export function permanenceLine(preview) {
  const t = preview?.totals;
  if (!t || t.students === 0) return '';

  const created = t.contacts > 0
    ? `create ${plural(t.contacts, 'contact')} (permanent) and ${passes(t.passes)} (permanent)`
    : 'create no contacts and no new School Passes';

  const sentence = `This will ${created}, and make ${plural(t.bookings, 'booking')} (cancellable).`;

  if (t.returning === 0) return sentence;
  return `${sentence} ${plural(t.returning, 'returning student')} may also need a pass `
    + '— checked at Apply.';
}

/**
 * What a run *is*, reduced to one comparable string — #111.
 *
 * The gate this feeds needs to answer "has this exact work already been done?",
 * and that question is about a list and a set of sessions under a school tag,
 * never about the page. A boolean `hasRun` would answer a different question
 * and answer it wrongly the moment a student is added, which is the realistic
 * second run and the one #74's UAT actually exercised.
 *
 * Three things go in, and each earns its place:
 *
 *   - **The school tag.** It is written onto every contact the run creates and
 *     is the only record of which school a student belongs to, so the same list
 *     under a second tag is a different write, not a repeat.
 *   - **Each runnable student**, as identity plus the resolution the operator
 *     settled on. Same names but `create` where it once said `use` is a new
 *     permanent contact — a different run wearing the same list.
 *   - **The session ids**, because the same students booked into a different
 *     week is a different run by every measure that matters.
 *
 * And what stays out matters as much.
 *
 * **Blocked rows**, because no run would have written them — so resolving one
 * is a change and leaving one alone is not.
 *
 * **The row key**, which is emphatically not an identity: it is the student's
 * first line number in the paste. Including it would mean the same list
 * re-pasted with a blank line on top read as a different import, purely because
 * every number shifted by one. Name and date of birth are the identity the rest
 * of this system matches on, and true duplicates are already collapsed before a
 * row reaches here, so the key adds instability and no discrimination.
 *
 * **Order**, on both lists. A paste arriving in a different order is the same
 * import, and the operator has no way to control it anyway.
 */
export function runFingerprint({ schoolTag, preview } = {}) {
  // JSON per row rather than a joined string: a separator character is only
  // unambiguous until a name contains it, and names here are arbitrary text.
  const rows = (preview?.rows ?? [])
    .filter((r) => !r.needsHuman)
    .map((r) => JSON.stringify([r.name, r.dob ?? '', r.clubworx, r.contactKey ?? '', r.resolution ?? '']))
    .sort();
  const sessions = (preview?.sessions ?? []).map((e) => String(e?.event_id)).sort();
  return JSON.stringify([String(schoolTag ?? ''), rows, sessions]);
}

/**
 * Everything step 5 shows, and everything that keeps Apply dark, from one call.
 *
 * @param {object} opts
 * @param {Array<object>} opts.rows step 3's rows, in step 3's order
 * @param {object} opts.matches `matchStudent` results (or `{error}`) keyed by row key
 * @param {object} opts.selection a `selectionReport`
 * @param {object} [opts.review] step 3's own `review()`, for its gates — see below
 * @param {object|null} opts.plan the `/plan` response body
 * @param {object} opts.decisions the match resolution log
 * @param {string} [opts.schoolTag] the school tag, for the already-run fingerprint
 * @param {{settled: boolean, fingerprint: string}|null} [opts.lastRun] the run
 *   this browser last finished, if any — `settled` is outcome.js's
 *   `settledRun()`. See the `already-run` gate below.
 */
export function buildPreview({ rows, matches, selection, review, plan, decisions, schoolTag, lastRun } = {}) {
  const log = decisions ?? {};
  const found = matches ?? {};
  const picked = selection ?? { events: [], blockers: [], sessions: 0 };
  const sessions = picked.sessions ?? 0;

  const students = (Array.isArray(rows) ? rows : []).filter((r) => r.bucket === 'record');
  const previewed = students
    .map((source) => previewRow(source, found[source.key], matchDecision(log, source.key), sessions))
    .sort((a, b) => a.key - b.key);

  const runnable = previewed.filter((r) => !r.needsHuman);
  const creating = runnable.filter((r) => r.clubworx === 'new');
  const returning = runnable.filter((r) => r.clubworx === 'matched');

  const totals = {
    students: runnable.length,
    blocked: previewed.length - runnable.length,
    contacts: creating.length,
    // One pass per new contact, exactly — a contact this run creates provably
    // holds none (D4). A returning student's pass is D14's, and is counted
    // apart rather than guessed at.
    passes: creating.length,
    returning: returning.length,
    bookings: runnable.length * sessions,
  };

  // Steps 3 and 4's blockers come first and unchanged. Apply reads **one**
  // list: §11 hard-stops on "any unresolved gate", and a gate that is only
  // visible on the screen that raised it is not a gate on the screen that
  // commits. It also closes the step 5 → 3 → 5 walk, where reopening the count
  // gate would otherwise leave a preview still saying it was ready.
  //
  // Carried verbatim, actions included, so a control that clears a gate on
  // step 3 clears it from here too rather than being a dead label.
  const blockers = [...(review?.blockers ?? []), ...(picked.blockers ?? [])];

  blockers.push(...planBlockers(plan, picked.lastSession));

  const unresolved = previewed.filter((r) => r.needsHuman);
  if (unresolved.length > 0) {
    blockers.push({
      key: 'unresolved-matches',
      kind: 'unresolved-matches',
      severity: 'block',
      title: `${plural(unresolved.length, 'student')} still needs you`,
      detail: unresolved.map((r) => r.name).join(', '),
      actions: [],
    });
  }

  if (runnable.length === 0) {
    blockers.push({
      key: 'nobody-to-book',
      kind: 'nobody-to-book',
      severity: 'block',
      title: 'No student can be booked',
      detail: 'Every row is held up on something. Nothing will run until at least one is clear.',
      actions: [],
    });
  }

  const fingerprint = runFingerprint({ schoolTag, preview: { rows: previewed, sessions: picked.events ?? [] } });

  // #111. `settled` is outcome.js's answer to "did this run leave anything
  // worth doing again", and it is what keeps this gate off §12 D5's recovery
  // re-run — the path D13 refused to warn against, and which this blocks rather
  // than warns. The rule lives there; this decides only what it closes.
  if (lastRun?.settled && lastRun.fingerprint === fingerprint) {
    blockers.push({
      key: 'already-run',
      kind: 'already-run',
      severity: 'block',
      title: 'This import has already been run',
      // Names the control that exists — #113's reset, which is the escape
      // valve this gate was always meant to have. Before it landed this line
      // said "reload the page", because pointing at a control that is not
      // there is worse than pointing at a clumsy one. The reset deliberately
      // does NOT re-open this gate: it starts a different import, and an
      // identical list re-pasted after one meets this same block.
      detail: 'Nothing here has changed since it ran, so applying again would repeat work that is '
        + 'already done. Add or resolve a student, or change the sessions, and this clears itself. '
        + 'To import a different school, use "Start another import" — it is on the result step and '
        + 'on step 1. This run stays saved in this browser.',
      actions: [],
    });
  }

  return {
    rows: previewed,
    totals,
    blockers,
    ready: !blockers.some((b) => b.severity === 'block'),
    plan: plan?.ok ? plan.plan : null,
    sessions: picked.events ?? [],
    lastSession: picked.lastSession ?? null,
    fingerprint,
  };
}

/**
 * What the School Pass plan stops.
 *
 * §11: an unresolved or ambiguous plan hard-stops the run, an unparseable
 * `membership_duration` warns **naming the raw value**, and a last session
 * outside the pass's coverage hard-stops.
 *
 * The coverage end is computed by the Worker (`/plan`), not here: the calendar
 * arithmetic lives in `cloudflare-clubworx/src/duration.js` with its own tests,
 * and a second copy in the browser is the drift that decides a run is safe when
 * it is not. A `coverage_end` the Worker did not send is therefore a **named
 * warning** rather than a check quietly skipped — which §11 forbids, and which
 * is also what an older Worker deployed behind this page looks like.
 */
function planBlockers(plan, lastSession) {
  if (!plan) {
    return [{
      key: 'plan',
      kind: 'plan',
      severity: 'block',
      title: 'The School Pass plan has not been looked up',
      detail: 'Nothing can be granted until Clubworx names exactly one plan.',
      actions: [],
    }];
  }

  if (!plan.ok) {
    return [{
      key: 'plan',
      kind: 'plan',
      severity: 'block',
      title: 'The School Pass plan could not be resolved',
      // Clubworx's own sentence, or the Worker's. Both already say which of
      // "missing", "ambiguous" and "the list was never read to the end" this is,
      // and those three send an operator to three different places.
      detail: plan.message || 'Clubworx did not name exactly one School Pass plan.',
      actions: [],
    }];
  }

  const out = [];
  const resolved = plan.plan ?? {};

  if (resolved.duration?.ok !== true) {
    out.push({
      key: 'plan-duration',
      kind: 'plan-duration',
      severity: 'warn',
      title: 'The pass length could not be read',
      detail: `The plan's duration is "${resolved.membership_duration ?? ''}", which this page cannot `
        + 'turn into a date. Check by hand that the pass will still be live at the last session.',
      actions: [],
    });
  }

  const coverage = resolved.coverage_end ?? null;
  if (!coverage) {
    out.push({
      key: 'coverage-unknown',
      kind: 'coverage-unknown',
      severity: 'warn',
      title: 'The pass coverage was not checked',
      detail: 'Clubworx did not say when a pass granted today would run out, so nothing has '
        + 'confirmed it reaches the last session.',
      actions: [],
    });
  } else if (lastSession && lastSession > coverage) {
    out.push({
      key: 'coverage',
      kind: 'coverage',
      severity: 'block',
      title: 'The pass runs out before the last session',
      // ADR 0005: *covers the last selected session*, not *active today*. Every
      // booking is written on a day the pass is live, so "active today" is the
      // answer that hides this until a session weeks away that nobody watches.
      detail: `A School Pass granted today covers to ${coverage}, and the last session picked is `
        + `${lastSession}. Book the sessions that fall inside the pass, or use a longer plan.`,
      actions: [],
    });
  }

  return out;
}
