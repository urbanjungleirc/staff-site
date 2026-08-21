/**
 * Turning live probe responses into something publishable.
 *
 * Everything a probe records goes through here first. The rule is that the
 * output holds counts, ids, status codes, header names and timings — and no row
 * of production data. Clubworx holds ~60,000 real people and staff-site#46's
 * standing constraint forbids real names reaching this public repo, so the
 * summariser is what makes a findings document safe to commit rather than a
 * gitignore rule somebody has to remember.
 */

/** Nearest-rank percentile. Null for an empty set, so it never prints as NaN. */
export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

/**
 * Summarise a burst of responses.
 *
 * @param {Array<{status?: number, ms: number, error?: string}>} samples
 */
export function summariseBurst(samples) {
  const byStatus = {};
  const errors = {};
  const latencies = [];
  let firstThrottledIndex = null;

  samples.forEach((sample, i) => {
    latencies.push(sample.ms);

    if (sample.error) {
      errors[sample.error] = (errors[sample.error] ?? 0) + 1;
      return;
    }

    byStatus[sample.status] = (byStatus[sample.status] ?? 0) + 1;
    // Index 0 is a real answer — a ceiling hit on the very first call — so this
    // stays null rather than 0 when nothing was throttled.
    if (sample.status === 429 && firstThrottledIndex === null) firstThrottledIndex = i;
  });

  const statuses = samples.filter(s => !s.error).map(s => s.status);

  return {
    count: samples.length,
    byStatus,
    errors,
    throttled: statuses.filter(s => s === 429).length,
    firstThrottledIndex,
    clean: samples.length > 0 && samples.every(s => !s.error && s.status >= 200 && s.status < 300),
    ms: {
      min: percentile(latencies, 0) ?? null,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      max: percentile(latencies, 100),
    },
  };
}

// The spellings seen in the wild: RFC 6585's Retry-After, the draft
// RateLimit-* family, and the older X- prefixed variants.
const RATE_LIMIT = /^(retry-after|x-)?(rate-?limit)/i;

/**
 * Pick out any header a client could self-throttle from.
 *
 * @param {Headers|Record<string,string>} headers
 * @returns {Record<string,string>}
 */
export function rateLimitHeaders(headers) {
  const entries =
    typeof headers?.entries === 'function' ? [...headers.entries()] : Object.entries(headers ?? {});

  const found = {};
  for (const [name, value] of entries) {
    const lower = String(name).toLowerCase();
    if (lower === 'retry-after' || RATE_LIMIT.test(lower)) found[lower] = String(value);
  }
  return found;
}

/**
 * Reduce an /events response to its shape.
 *
 * Ids and the field list only. Event names at UJ carry school names, and
 * `instructor_name` is a staff member — neither may be written down here.
 *
 * @param {unknown} body
 */
export function summariseEvents(body) {
  if (!Array.isArray(body)) {
    return { count: 0, ids: [], fields: [], earliest: null, latest: null, notAnArray: true };
  }

  const fields = new Set();
  const starts = [];
  for (const row of body) {
    for (const key of Object.keys(row ?? {})) fields.add(key);
    if (row?.event_start_at) starts.push(row.event_start_at);
  }
  starts.sort();

  return {
    count: body.length,
    ids: body.map(r => r?.event_id).sort((a, b) => a - b),
    fields: [...fields],
    earliest: starts[0] ?? null,
    latest: starts[starts.length - 1] ?? null,
    notAnArray: false,
  };
}

/**
 * Describe an observed ceiling as requests per minute.
 *
 * Clubworx sends no rate-limit headers even while returning 429 (staff-site#51,
 * confirmed under live throttling), so a client cannot read a limit — it can
 * only measure one. Two numbers are needed and both come from a probe: how many
 * requests were accepted before the wall, and how long the wall lasted.
 *
 * The result is an inference, not a published figure, so the raw measurements
 * travel with it.
 *
 * @param {{allowed: number, windowMs: number}} observed
 */
export function deriveRateLimit({ allowed, windowMs }) {
  if (!(windowMs > 0)) throw new Error('deriveRateLimit: window must be a positive duration');
  if (!(allowed > 0)) {
    throw new Error(
      'deriveRateLimit: allowed must be positive — a run that was never throttled ' +
        'shows the limit is above what was tried, not what it is',
    );
  }
  return { allowed, windowMs, perMinute: Math.round((allowed / windowMs) * 60_000) };
}

/**
 * A pace to run at, given a measured ceiling.
 *
 * Concurrency is always 1. Under a per-window quota, eight requests in flight
 * spend the allowance exactly as fast as one — concurrency changes only how
 * soon the wall arrives, so the lever that matters is the gap between requests.
 *
 * @param {{allowed: number, windowMs: number, safety?: number, reads?: number}} opts
 */
export function recommendPacing({ allowed, windowMs, safety = 0.8, reads }) {
  const { perMinute: ceiling } = deriveRateLimit({ allowed, windowMs });
  const perMinute = Math.floor(ceiling * safety);
  const gapMs = Math.round(60_000 / perMinute);

  return {
    concurrency: 1,
    perMinute,
    gapMs,
    safety,
    estimatedMsFor: reads ? reads * gapMs : null,
  };
}

/** Do two runs describe the same set of events, regardless of order? */
export function sameIds(a, b) {
  if (a.length !== b.length) return false;
  const left = new Set(a);
  return b.every(id => left.has(id));
}

/**
 * Reduce a contact list to its shape, naming only contacts this probe created.
 *
 * staff-site#49 searches on a *partial* email (`email=noreply%2B`), so whatever
 * else in the gym happens to match comes back with it — real members, with real
 * names and real addresses. The count is the finding; the rows are not. Only
 * `contact_key`s already known to the caller survive, because those are the ones
 * the probe wrote and is about to hand back as a cleanup list.
 *
 * @param {unknown} body
 * @param {string[]} [ourKeys] Contact keys this probe created or reused.
 */
export function summariseContacts(body, ourKeys = []) {
  if (!Array.isArray(body)) {
    return { count: 0, fields: [], ours: [], strangers: 0, notAnArray: true };
  }

  const known = new Set(ourKeys);
  const fields = new Set();
  const ours = [];
  let strangers = 0;

  for (const row of body) {
    for (const key of Object.keys(row ?? {})) fields.add(key);
    if (known.has(row?.contact_key)) ours.push(row.contact_key);
    else strangers += 1;
  }

  return { count: body.length, fields: [...fields], ours: ours.sort(), strangers, notAnArray: false };
}

/**
 * What a write response means — did a contact come into existence?
 *
 * Two questions that are not the same one: whether a record now exists, and
 * whether the server told us why not. Clubworx cannot delete contacts through
 * the API, so anything that *might* have landed has to be treated as though it
 * did — the cleanup list is the only record anyone gets, and a contact missing
 * from it is a permanent row nobody knows the key of.
 *
 * A lost response is therefore `mayExist: true`, and only a 4xx is a rejection.
 *
 * @param {{status?: number|null, error?: string|null, refused?: string|null}} sample
 */
export function classifyWrite({ status, error, refused } = {}) {
  if (refused) return { outcome: 'refused', mayExist: false, conclusive: false };
  if (error) return { outcome: 'failed', mayExist: true, conclusive: false };

  // Clubworx answers 200 on create, not 201, so the whole 2xx range counts.
  if (status >= 200 && status < 300) return { outcome: 'created', mayExist: true, conclusive: true };
  if (status >= 400 && status < 500) return { outcome: 'rejected', mayExist: false, conclusive: true };

  return { outcome: 'failed', mayExist: true, conclusive: false };
}

/**
 * Does #49's answer collapse the school-marking scheme?
 *
 * The ticket: *"If plus-addressing is rejected, or email turns out to be
 * unique-constrained, the marking decision ... **collapses** ... Say so
 * explicitly rather than inventing a workaround."*
 *
 * Only a **conclusive rejection** means that. A timeout or a 500 means run it
 * again — reporting either as a collapse would invent exactly the conclusion
 * the ticket asked to be stated only when true, and would send someone to
 * re-decide a design over a dropped packet.
 *
 * @param {{plus: object|null, duplicate: object|null}} outcomes Results of classifyWrite.
 */
export function schemeCollapses({ plus, duplicate }) {
  if (plus?.outcome === 'rejected') {
    return {
      collapsed: true,
      inconclusive: false,
      reason: 'plus-addressing was rejected — the noreply+<school> marker cannot be written',
    };
  }
  if (duplicate?.outcome === 'rejected') {
    return {
      collapsed: true,
      inconclusive: false,
      reason: 'email is unique per contact — siblings and whole schools cannot share an address',
    };
  }

  const attempted = [plus, duplicate].filter(Boolean);
  return {
    collapsed: false,
    inconclusive: attempted.length > 0 && attempted.some(o => !o.conclusive),
    reason: null,
  };
}

/**
 * Did a plus-tag search isolate the contacts carrying that tag?
 *
 * This is the question staff-site#46's school-marking scheme rests on. It has
 * two distinct failure modes and they are not interchangeable: a tag that
 * *leaks* another school's contacts makes the marker useless for selecting, and
 * a tag that *misses* its own makes it useless for finding. Both are reported
 * rather than collapsed into one boolean, so the write-up can say which.
 *
 * `endpointHoldsOurs` separates "the marker does not work here" from "our
 * contacts are not here to be found". A contact created as a prospect does not
 * appear under `/members` at all, and scoring that as an isolation failure would
 * report a working marker as a broken one.
 *
 * @param {{returned?: string[], expected?: string[], excluded?: string[], endpointHoldsOurs?: boolean}} opts
 */
export function describeIsolation({
  returned = [],
  expected = [],
  excluded = [],
  endpointHoldsOurs = true,
}) {
  const got = new Set(returned);
  const missing = expected.filter(key => !got.has(key));
  const crossTag = excluded.filter(key => got.has(key));

  if (!endpointHoldsOurs) {
    return { applicable: false, isolated: null, missing, crossTag, returnedCount: returned.length };
  }

  return {
    applicable: true,
    isolated: returned.length > 0 && missing.length === 0 && crossTag.length === 0,
    missing,
    crossTag,
    returnedCount: returned.length,
  };
}

/**
 * Reduce a bookings response to something publishable.
 *
 * `GET /bookings?contact_key=` is scoped to one contact, so unlike the contact
 * searches this is not sifting a 60,000-person database — but the rule from
 * `summariseContacts` holds anyway. The endpoint is not *guaranteed* to scope:
 * staff-site#51 found `/events` ignoring `contact_key` outright while the
 * reference called it required, so a row that arrives for somebody else is
 * counted and dropped rather than trusted and printed.
 *
 * @param {unknown} body
 * @param {string[]} [ourKeys] Contact keys belonging to probe contacts.
 */
export function summariseBookings(body, ourKeys = []) {
  if (!Array.isArray(body)) {
    return { count: 0, fields: [], ids: [], ours: 0, strangers: 0, notAnArray: true };
  }

  const known = new Set(ourKeys);
  const fields = new Set();
  const ids = [];
  let ours = 0;
  let strangers = 0;

  for (const row of body) {
    for (const key of Object.keys(row ?? {})) fields.add(key);

    // A row with no contact_key at all came back from a query that was already
    // scoped to one contact, so it counts as ours. Calling it a stranger would
    // make the before/after counts that answer questions 3 and 4 unreadable.
    const key = row?.contact_key;
    if (key === undefined || known.has(key)) {
      ours += 1;
      const id = row?.booking_id ?? row?.id;
      if (id !== undefined && id !== null) ids.push(String(id));
    } else {
      strangers += 1;
    }
  }

  return {
    count: body.length,
    fields: [...fields],
    ids: ids.sort(),
    ours,
    strangers,
    notAnArray: false,
  };
}

/**
 * Question 2: what does a booking actually require?
 *
 * staff-site#50 asks this only if question 1 fails, and names the candidate
 * discriminator itself: `GET /events` returns a `free_class` boolean. Comparing
 * one event against another is what separates "a membership-less contact cannot
 * book at all" from "it can book, but only into certain events" — and those two
 * answers change #46's tool in very different ways.
 *
 * `free_class` is a *candidate* discriminator, not a confirmed one. UJ's school
 * sessions are configured with a limited number of prospect places, which is the
 * mechanism staff actually rely on, and `GET /events` does not return it at all
 * (verified 2026-08-18). So `paid` and `free` here are really "the event asked
 * about" and "an event configured differently" — the names follow the ticket's
 * wording rather than a proven mechanism, and a caller must record *which
 * events* were compared, not just the verdict.
 *
 * One attempt cannot answer it, so an unattempted half is `null` rather than a
 * guess. The ticket asks for a failure here to be flagged loudly, which the
 * caller can only do if it can tell "no" from "not asked".
 *
 * @param {{paid?: object|null, free?: object|null}} outcomes Results of classifyWrite.
 */
export function describeBookingRequirement({ paid = null, free = null }) {
  const ok = sample => sample?.outcome === 'created';
  const rejected = sample => sample?.outcome === 'rejected';

  if (ok(paid)) {
    return {
      requirement: 'none',
      entitlementNeeded: false,
      freeClassOnly: false,
      inconclusive: false,
      summary: 'a membership-less prospect can be booked into an ordinary paid event',
    };
  }

  if (rejected(paid) && ok(free)) {
    return {
      requirement: 'free_class',
      entitlementNeeded: false,
      freeClassOnly: true,
      inconclusive: false,
      summary:
        'a membership-less prospect can only be booked into an event flagged free_class — ' +
        'the picker must filter on it',
    };
  }

  if (rejected(paid) && rejected(free)) {
    return {
      requirement: 'entitlement',
      entitlementNeeded: true,
      freeClassOnly: false,
      inconclusive: false,
      summary:
        'a membership-less prospect cannot be booked at all — a membership or plan is required, ' +
        'which changes the shape of the tool',
    };
  }

  // Everything else — a timeout, a 500, or a comparison never run — is not an
  // answer. Reporting it as one would send someone to re-decide a design over a
  // dropped packet, which is the trap `schemeCollapses` exists to avoid.
  return {
    requirement: null,
    entitlementNeeded: null,
    freeClassOnly: null,
    inconclusive: true,
    summary:
      paid === null
        ? 'no booking was attempted'
        : 'the attempt did not complete conclusively — re-run before concluding anything',
  };
}

/**
 * Question 3: is booking the same contact into the same event twice idempotent?
 *
 * The safety model of #46's tool assumes re-running it against an event cannot
 * double-book a student. Two outcomes are safe and one is not, and they are
 * told apart by what the server *did*, not by what it said:
 *
 *   - a rejection is safe and explicit;
 *   - a success that produced no second booking is safe and idempotent;
 *   - a success that produced a second booking is the dangerous one, and it is
 *     invisible unless the bookings are counted before and after.
 *
 * @param {{second?: object|null, countBefore?: number|null, countAfter?: number|null}} opts
 */
export function describeDuplicateBooking({ second = null, countBefore = null, countAfter = null }) {
  if (second?.outcome === 'rejected') {
    return {
      duplicated: false,
      idempotent: true,
      rejected: true,
      inconclusive: false,
      summary: 'the second booking was rejected — re-running the tool cannot double-book',
    };
  }

  if (second?.outcome !== 'created') {
    return {
      duplicated: null,
      idempotent: null,
      rejected: false,
      inconclusive: true,
      summary: 'the second attempt did not complete — it says nothing about idempotency',
    };
  }

  if (typeof countBefore !== 'number' || typeof countAfter !== 'number') {
    // Accepted, but nobody counted. This is exactly the case that must not be
    // reported as safe: from the response alone, a silent second booking looks
    // identical to an idempotent one.
    return {
      duplicated: null,
      idempotent: null,
      rejected: false,
      inconclusive: true,
      summary: 'the second booking was accepted but the bookings were not counted — unproven',
    };
  }

  const duplicated = countAfter > countBefore;
  return {
    duplicated,
    idempotent: !duplicated,
    rejected: false,
    inconclusive: false,
    summary: duplicated
      ? `the second booking was accepted AND created another (${countBefore} → ${countAfter}) — ` +
        're-running the tool double-books'
      : `the second booking was accepted but created nothing new (${countBefore} → ${countAfter}) — ` +
        'the server is idempotent',
  };
}

/**
 * Question 4: did `DELETE` actually reverse the booking?
 *
 * "HTTP 200" is not the finding. The booking either left the contact's list or
 * it did not, and only a re-read can say which — so a cancellation is judged on
 * the count afterwards, and a 2xx with the booking still present is reported as
 * a failure rather than a success. #46 plans to rely on this to undo a mistaken
 * bulk booking, so a false "reversible" here is worse than no answer.
 *
 * @param {{cancel?: object|null, countBefore?: number|null, countAfter?: number|null}} opts
 */
export function describeCancellation({ cancel = null, countBefore = null, countAfter = null }) {
  if (!cancel || cancel.refused) {
    return {
      reversed: null,
      inconclusive: true,
      summary: cancel?.refused
        ? 'the cancellation was refused locally'
        : 'no cancellation was attempted',
    };
  }

  // A dry run is not a rejection. Without this it falls through to the final
  // branch and reports "DELETE was rejected — the booking must be removed by
  // hand", which invents a failure out of a request nobody sent.
  if (cancel.dryRun) {
    return { reversed: null, inconclusive: true, summary: 'dry run — no DELETE was sent' };
  }

  const accepted = typeof cancel.status === 'number' && cancel.status >= 200 && cancel.status < 300;

  if (typeof countBefore !== 'number' || typeof countAfter !== 'number') {
    return {
      reversed: null,
      inconclusive: true,
      summary: `DELETE answered ${cancel.status ?? 'nothing'}, but the bookings were not re-counted — unproven`,
    };
  }

  const gone = countAfter < countBefore;

  if (accepted && gone) {
    return {
      reversed: true,
      inconclusive: false,
      summary: `DELETE reversed the booking cleanly (${countBefore} → ${countAfter})`,
    };
  }
  if (accepted && !gone) {
    return {
      reversed: false,
      inconclusive: false,
      summary:
        `DELETE answered ${cancel.status} but the booking is still there (${countBefore} → ${countAfter}) — ` +
        'the tool cannot rely on it to undo a mistake',
    };
  }
  return {
    reversed: false,
    inconclusive: false,
    summary:
      `DELETE was rejected (HTTP ${cancel.status ?? 'n/a'}) — the booking remains and must be ` +
      'removed by hand',
  };
}

/**
 * `summariseMemberships` moved to `src/memberships.js` (staff-site#69).
 *
 * The Worker's write chain needs the same derivation the probes needed — a
 * membership has no `status` field, so "active" comes from `start_date` and
 * `expiration_date` — and #69 also needs a second question answered against the
 * same rows: does the held pass reach the last selected session? Both live
 * beside each other in `src/memberships.js` now, the same way `errorMessageOf`
 * and `buildUrl` were promoted out of here before it. Probes import it from
 * there; there is one definition.
 *
 * `findPlanByName` moved to `src/plans.js`, and `describeLeadTime` and
 * `pickBookableEvents` to `src/events.js` (staff-site#67), for the same reason
 * and by the same route: #67's three read routes are built on exactly the
 * measured behaviour these encode — the `/membership_plans` truncation that hid
 * School Pass, and the 24-hour lead time no endpoint exposes — and a Worker
 * re-deriving them would re-derive their bugs (§6). Probes import them from
 * `src/` now.
 */

/**
 * Did the create actually land? Decided by the re-read, never by the status.
 *
 * staff-site#63's standing rule — *"verify each write by re-reading the
 * resource, never by the status code"* — exists because this map has been
 * misled by a status twice. #50 read a malformed request's `401` as a
 * permissions wall. #49 found that a successful contact create answers `200`
 * where a reader would expect `201`. Neither number described what was in the
 * database.
 *
 * So the verdict here comes from what a subsequent search found, and the status
 * code is demoted to a single boolean — `statusAgrees` — whose only job is to
 * record *whether Clubworx told the truth this time*. That is itself a finding
 * the write-up wants, and it is not the same question as whether a permanent
 * contact now exists.
 *
 * Three distinctions are load-bearing, because contacts cannot be deleted:
 *
 *   - **`absent` vs `unverified`.** "We looked and it was not there" and "we did
 *     not look" must not collapse. The first means nothing was created; the
 *     second means something may have been, and belongs on the cleanup list.
 *   - **A transport error is not a failure.** A write that threw may still have
 *     landed — ACCESS.md says so — and the re-read is the only thing that knows.
 *   - **`duplicated` is named, not averaged.** Taking `[0]` of two rows would
 *     hide a second permanent record behind a cheerful "created".
 *
 * @param {object} opts
 * @param {{status?: number|null, error?: string|null, refused?: string|null}} opts.create
 * @param {Array<{contact_key?: string}>|null} [opts.found] Rows the re-read matched, or null if it did not run.
 */
export function describeMemberCreation({ create = {}, found = null } = {}) {
  const { status = null, error = null, refused = null } = create ?? {};

  // A local refusal never reached the network, so nothing can be claimed about
  // production and there is no status to agree or disagree with.
  if (refused) {
    return {
      verdict: 'refused',
      landed: false,
      contactKey: null,
      duplicates: 0,
      status,
      statusAgrees: null,
      refused,
      summary: `refused before the request: ${refused}`,
    };
  }

  if (found === null || found === undefined) {
    return {
      verdict: 'unverified',
      landed: null,
      contactKey: null,
      duplicates: 0,
      status,
      statusAgrees: null,
      refused: null,
      summary:
        `HTTP ${status ?? 'n/a'} and no re-read — whether a permanent contact exists is unknown`,
    };
  }

  const rows = Array.isArray(found) ? found.filter(Boolean) : [];
  const ok = typeof status === 'number' && status >= 200 && status < 300;

  if (rows.length === 0) {
    return {
      verdict: 'absent',
      landed: false,
      contactKey: null,
      duplicates: 0,
      status,
      // A 2xx with nothing behind it is the case worth shouting about; a 4xx
      // with nothing behind it is Clubworx being honest.
      statusAgrees: !ok,
      refused: null,
      summary: ok
        ? `HTTP ${status} but the re-read found nothing — the status did not describe the database`
        : `HTTP ${status ?? 'n/a'} and the re-read found nothing — nothing was created`,
    };
  }

  const verdict = rows.length > 1 ? 'duplicated' : 'created';

  return {
    verdict,
    landed: true,
    contactKey: rows[0].contact_key ?? null,
    duplicates: rows.length,
    status,
    statusAgrees: ok,
    refused: null,
    summary:
      verdict === 'duplicated'
        ? `${rows.length} contacts match — a duplicate was created and cannot be deleted`
        : `HTTP ${status ?? 'n/a'}${ok ? '' : ' (or none)'} and the re-read found it — created`,
  };
}

const DAY_MS = 86_400_000;

/**
 * What pass the contact ended up holding, and on whose terms — questions 3 and 4.
 *
 * Question 3 asks whether `membership_plan_id` on `POST /members` produces a
 * *usable* pass; question 4 asks what `start_date` it gets, since that call
 * accepts none. The trade-off #63 has to price is exactly there: the two-call
 * route sends a start date and reads a 12-week expiry back, and the one-call
 * route would hand that choice to Clubworx.
 *
 * `startsOnCreationDay` and `spanDays` are what make the answer a measurement
 * rather than an impression, and `honouredRequest` stays **null** when no start
 * date was asked for — the one-call route sends none, so there is nothing there
 * to have been honoured or ignored, and reporting `false` would read as
 * "Clubworx overrode us".
 *
 * Takes the `planStates` from `summariseMemberships` rather than raw rows, so
 * the "a membership has no `status` field" rule (#60) is applied in exactly one
 * place.
 *
 * @param {object} opts
 * @param {Array<{start_date?: string|null, expiration_date?: string|null, active?: boolean}>} opts.states
 * @param {string} opts.on ISO day the create ran.
 * @param {string|null} [opts.requested] The start_date that was asked for, if any.
 */
export function describeCreatedPass({ states = [], on, requested = null } = {}) {
  const held = Array.isArray(states) ? states.filter(Boolean) : [];

  if (held.length === 0) {
    return {
      granted: false,
      active: false,
      held: 0,
      startDate: null,
      expirationDate: null,
      spanDays: null,
      startsOnCreationDay: false,
      honouredRequest: requested ? false : null,
      summary: 'no pass on this plan',
    };
  }

  // An expired pass is still a held plan. Reporting its dates as the answer
  // would describe a pass the booking will not accept.
  const state = held.find(s => s.active) ?? held[0];
  const startDate = state.start_date ?? null;
  const expirationDate = state.expiration_date ?? null;

  const start = startDate ? Date.parse(`${startDate}T00:00:00Z`) : NaN;
  const end = expirationDate ? Date.parse(`${expirationDate}T00:00:00Z`) : NaN;
  const spanDays =
    Number.isNaN(start) || Number.isNaN(end) ? null : Math.round((end - start) / DAY_MS);

  return {
    granted: true,
    active: Boolean(state.active),
    held: held.length,
    startDate,
    expirationDate,
    spanDays,
    startsOnCreationDay: startDate !== null && startDate === on,
    honouredRequest: requested ? startDate === requested : null,
    summary:
      `start ${startDate ?? 'n/a'} · expires ${expirationDate ?? 'n/a'}` +
      (spanDays === null ? '' : ` · ${spanDays}d`) +
      ` · active ${Boolean(state.active)}`,
  };
}

/** A bare object and a one-element array are the same one row, read the same way. */
const rowsOf = body => (Array.isArray(body) ? body : body && typeof body === 'object' ? [body] : []);

/** Field names of whatever came back, in first-seen order. Names only, never values. */
const fieldNamesOf = body => {
  const names = new Set();
  for (const row of rowsOf(body)) for (const name of Object.keys(row ?? {})) names.add(name);
  return [...names];
};

/** A pasted id is a string and Clubworx sends a number. Compare as text or nothing matches. */
const sameEventId = (row, wanted) => String(row?.event_id) === String(wanted);

/**
 * What a `GET /events/:id` response *is* — a resolved event, or the collection
 * wearing its clothes.
 *
 * Shared by the direct call, the made-up id and the windowless call, so all
 * three are read by one set of rules rather than three sets that drift.
 */
function shapeOf(res, wanted) {
  if (!res) return null;
  if (res.error) return 'error';

  const { status, body } = res;

  // #50 is the standing reminder of what reading a 401 as a wall costs: a
  // malformed request answered "Authorization failed", it was written up as a
  // permissions problem, and an architectural route was lost for a week.
  if (status === 401 || status === 403) return 'refused';
  if (status === 404) return 'not-found';
  if (status === 422) return 'rejected';
  if (typeof status !== 'number' || status < 200 || status >= 300) return 'error-status';

  if (Array.isArray(body)) {
    if (body.length === 0) return 'empty';
    // One row that is not the row asked for means the path segment was ignored
    // and the window happened to hold a single event — the collection, not a
    // resolution.
    if (body.length === 1 && sameEventId(body[0], wanted)) return 'one-element-array';
    return 'collection';
  }

  if (body && typeof body === 'object') {
    return sameEventId(body, wanted) ? 'single-object' : 'unrecognised';
  }

  return 'unrecognised';
}

/** The shapes `resolveEvent` in `../src/events.js` accepts as one confirmed event. */
const RESOLVING = new Set(['single-object', 'one-element-array']);

const SHAPE_SUMMARY = {
  'single-object': 'a bare object carrying the id asked for — events/:id resolves',
  'one-element-array': 'a one-element array carrying the id asked for — events/:id resolves',
  collection: 'the /events collection — the path segment is ignored, not addressed',
  empty: 'an empty array — read as a filter that matched nothing, not as an address',
  'not-found': '404 — there is no events/:id route',
  rejected: '422 — the request was refused, not the id',
  refused:
    'a 401/403. Nothing follows from it: read the endpoint\'s parameters before ' +
    'concluding a route is absent (#50)',
  error: 'the request never completed — unmeasured, not absent',
  'error-status': 'an unexpected status',
  unrecognised: 'a 2xx body that is neither an event nor a list of them',
};

/**
 * staff-site#97 — is `GET /api/v2/events/:id` a route, and does the shipped
 * paste-the-id fallback survive whatever it is?
 *
 * `resolveEvent` was written against both plausible shapes and shipped on #67
 * without ever being called: every probe up to here read the `/events`
 * collection. Path addressing does exist in this API (`DELETE /bookings/:id`,
 * #60), which is why `events/:id` was the guess — but a guess is what #50 cost a
 * week on, so it gets measured.
 *
 * `isRoute` and `resolvesFallback` are separate answers on purpose.
 * `resolvesFallback` is the one #54 depends on: it is true only for the two
 * shapes `resolveEvent` accepts *and* only when the row carries the id that was
 * asked for. A route that answers with the collection is still "a 200", and
 * reading it as success is exactly how the wrong class would reach an operator
 * to confirm.
 *
 * Nothing here records a row: field **names**, ids and statuses only.
 *
 * @param {object} opts
 * @param {string|number} opts.wantedId The real event id the direct call asked for.
 * @param {{status: number|null, body: unknown, error: string|null}} opts.direct
 *   `GET events/<real id>`, inside the date window.
 * @param {{status: number|null, body: unknown, error: string|null}} [opts.missing]
 *   `GET events/<an id that does not exist>`. Omitted when that call was not made.
 * @param {{status: number|null, body: unknown, error: string|null}} [opts.windowless]
 *   `GET events/<real id>` with no date window. Omitted when that call was not made.
 * @param {Array<string|number>} [opts.collectionIds] Ids the listing walk held, to
 *   tell "answered with the collection" from "answered with an event".
 */
export function describeEventById({
  wantedId,
  direct = null,
  missing = null,
  windowless = null,
  collectionIds = null,
} = {}) {
  const verdict = shapeOf(direct, wantedId) ?? 'error';
  const resolvesFallback = RESOLVING.has(verdict);

  // Three states, and the third is the point. `false` is a measured absence;
  // `null` is "this run did not find out", which a refusal or a dropped
  // connection is. Collapsing them would write an unmeasured "no" into the
  // findings.
  const isRoute =
    resolvesFallback ? true
    : verdict === 'refused' || verdict === 'error' || verdict === 'error-status' ? null
    : false;

  const returnedIds = rowsOf(direct?.body)
    .map(r => r?.event_id)
    .filter(id => id !== null && id !== undefined);
  const echoesCollection =
    Array.isArray(collectionIds) && collectionIds.length > 0 && returnedIds.length > 0
      ? sameIds(returnedIds, collectionIds)
      : false;

  const missingBehaviour = shapeOf(missing, `${wantedId}-does-not-exist`);
  // A route that answers a made-up id the same way it answers a real one tells
  // an operator nothing, and a paste field built on it would confirm anything
  // typed into it.
  const discriminates =
    missingBehaviour === null ? null : !RESOLVING.has(missingBehaviour) && missingBehaviour !== 'collection';

  const windowlessShape = shapeOf(windowless, wantedId);
  const windowRequired = windowlessShape === null ? null : !RESOLVING.has(windowlessShape);

  return {
    verdict,
    isRoute,
    resolvesFallback,
    status: direct?.status ?? null,
    fields: fieldNamesOf(direct?.body),
    returnedIds,
    echoesCollection,
    missingBehaviour,
    missingStatus: missing?.status ?? null,
    discriminates,
    windowRequired,
    windowlessStatus: windowless?.status ?? null,
    summary: `HTTP ${direct?.status ?? 'n/a'} · ${SHAPE_SUMMARY[verdict] ?? verdict}`,
  };
}
