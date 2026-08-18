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
 * a paid event against a free one is what separates "a membership-less contact
 * cannot book at all" from "it can book, but only a free class" — and those two
 * answers change #46's tool in very different ways.
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
 * Which events a probe may safely be booked into.
 *
 * A booking is a real row on a real class that staff see, so the choice of
 * event is not arbitrary. It must be in the **future**, so nobody is standing
 * in a gym waiting for a `Ztest`; and it must have **room**, because consuming
 * the last space would cause #46's own worst case — a school group arriving at
 * an event with fewer spaces than students.
 *
 * Both kinds come back separately because question 2 needs the comparison: an
 * event flagged `free_class` and an ordinary one.
 *
 * @param {unknown} body A `GET /events` response.
 * @param {{now?: string}} [opts]
 */
export function pickBookableEvents(body, { now = new Date().toISOString() } = {}) {
  if (!Array.isArray(body)) return { free: [], paid: [], skipped: 0 };

  const free = [];
  const paid = [];
  let skipped = 0;

  for (const row of body) {
    const starts = row?.event_start_at ?? null;
    const roomy = row?.event_full !== true && (row?.spaces_available ?? 0) > 0;

    if (!starts || starts <= now || !roomy) {
      skipped += 1;
      continue;
    }

    // The name travels because a human has to recognise the class they are
    // about to put a test booking on. An event name is a timetable entry —
    // nothing here describes a person.
    const event = {
      event_id: row.event_id,
      event_name: row.event_name ?? null,
      event_start_at: starts,
      spaces_available: row.spaces_available ?? null,
      free_class: row.free_class === true,
    };

    (event.free_class ? free : paid).push(event);
  }

  const byStart = (a, b) => String(a.event_start_at).localeCompare(String(b.event_start_at));
  return { free: free.sort(byStart), paid: paid.sort(byStart), skipped };
}
