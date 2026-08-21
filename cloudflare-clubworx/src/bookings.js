/**
 * Booking, cancelling, and the error vocabulary that tells them apart.
 *
 * staff-site#69. Design: `docs/superpowers/specs/2026-08-19-school-group-booking-design.md`
 * §11 (refusals and retries) and §12 (irreversibility, and the interlock).
 *
 * ---------------------------------------------------------------------------
 * Three refusals share HTTP 400. The message string is the only discriminator
 * ---------------------------------------------------------------------------
 * There is no code, no field, no header that separates them — only `{"error":
 * "..."}` — and they mean entirely different things:
 *
 * | Clubworx says | Means |
 * |---|---|
 * | already booked into this class | **success**. It *is* the idempotency guarantee |
 * | now closed for bookings | permanent for that event; the lead-time stop should pre-empt it |
 * | no free spaces available | the **prospect allowance**, not capacity (#50) |
 * | anything else | unknown — verbatim, never retried, never re-worded |
 *
 * **D6 — an unrecognised message is never paraphrased.** #50 is the cautionary
 * tale: `"Sorry, this class has no free spaces available."` arrived on an event
 * reporting 25 spaces free and `event_full: false`, and reading it as a capacity
 * problem pointed the whole effort at the wrong mechanism for a week. So the
 * spaces refusal is shown as *"Refused — check the session"* with
 * `spaces_available` beside it, and **never** as "class full".
 *
 * ---------------------------------------------------------------------------
 * The cancel interlock is a safety property, not a display distinction
 * ---------------------------------------------------------------------------
 * Because booking is idempotent, a re-run marks rows `already booked`. A cancel
 * scoped to the whole row set would therefore delete bookings **this run did not
 * create** — possibly a session a real member booked themselves, which #50
 * identified as the worst outcome available on this map.
 *
 * So `cancelRunBookings` acts on `booked` and never on `already booked`, and it
 * carries no override. Both callers need it: the human "Cancel bookings from
 * this run" control, and **D3's automatic rollback, which runs the same path
 * with no human present**.
 *
 * The interlock is enforced twice on purpose — `bookEvent` never returns a
 * booking id on an already-booked row, and `cancelRunBookings` refuses the state
 * outright. Either alone would hold; the one that fails silently is the one
 * worth doubling.
 *
 * ---------------------------------------------------------------------------
 * `POST /bookings` sends JSON
 * ---------------------------------------------------------------------------
 * Measured — `probes/lib/booking.mjs` sent a JSON body and got the 200 that
 * created booking `63510241` (#60). §2's summary table says `/bookings` is
 * form-encoded; that line does not match what was run, and **what was run is
 * what is implemented here**. `/memberships` genuinely is form-encoded, which is
 * probably where the line came from. The encoding is per-endpoint.
 */

import { errorMessageOf } from './errors.js';
import { isRetryable, upstreamReason, upstreamMessage } from './upstream.js';

/**
 * The row states, as constants rather than as literals typed twice.
 *
 * `BOOKED` and `ALREADY_BOOKED_STATE` differ from the refusal *kind*
 * `'already-booked'` by one character — a space against a hyphen — and the
 * consequence of confusing them is not cosmetic: `cancelRunBookings` acts on
 * `BOOKED` and the chain treats `ALREADY_BOOKED_STATE` as a success, so a slip
 * either abandons a complete student or points the rollback at a booking this
 * run did not create. Two near-identical strings compared by hand across three
 * files is exactly the shape that eventually gets one of them wrong.
 */
export const BOOKED = 'booked';
export const ALREADY_BOOKED_STATE = 'already booked';
export const REFUSED = 'refused';
export const FAILED = 'failed';

/** The three measured 400s, verbatim, as the reference points for matching. */
export const ALREADY_BOOKED = "Woops! You've already booked into this class!";
export const CLASS_CLOSED = 'Sorry! This class is now closed for bookings.';
export const NO_FREE_SPACES = 'Sorry, this class has no free spaces available.';

/**
 * Normalise only what cannot change the meaning: case, whitespace and the shape
 * of an apostrophe.
 *
 * The apostrophe is not hypothetical — `You've` is one HTML-entity round trip
 * away from `You’ve`, and an exact-match classifier would quietly demote the
 * success-equivalent refusal to `unknown`, which turns a clean idempotent re-run
 * into an abandoned student and a rollback.
 */
const normalise = text =>
  String(text ?? '')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/**
 * Matched on the distinctive clause rather than the whole sentence.
 *
 * Wide enough that punctuation drift does not reclassify a known message;
 * narrow enough that it cannot swallow a new one. `"Sorry, this class is full."`
 * — a message nobody has seen — must come out `unknown`, not `no-spaces`.
 */
const SIGNATURES = [
  ['already-booked', 'already booked into this class'],
  ['closed', 'now closed for bookings'],
  ['no-spaces', 'no free spaces available'],
];

/**
 * Which of the four a refusal is.
 *
 * @param {unknown} message The message Clubworx sent, exactly as it sent it.
 * @returns {'already-booked'|'closed'|'no-spaces'|'unknown'}
 */
export function classifyRefusal(message) {
  const text = normalise(message);
  if (!text) return 'unknown';
  for (const [kind, signature] of SIGNATURES) {
    if (text.includes(signature)) return kind;
  }
  return 'unknown';
}

/**
 * What an operator is shown for a refusal.
 *
 * @param {'closed'|'no-spaces'|'unknown'|'already-booked'} kind
 * @param {{message?: string|null, spacesAvailable?: number|null}} [opts]
 * @returns {string}
 */
export function describeRefusal(kind, { message = null, spacesAvailable = null } = {}) {
  if (kind === 'already-booked') return 'Already booked — nothing to do.';

  if (kind === 'closed') {
    return (
      'Refused — Clubworx has closed this session for bookings. ' +
      'It starts too soon; it should have been caught before the run started.'
    );
  }

  if (kind === 'no-spaces') {
    // Deliberately not "class full". The message is about a per-contact
    // allowance, and it has arrived on an event with 25 spaces free.
    return (
      'Refused — check the session' +
      (spacesAvailable === null ? '' : ` (Clubworx reports ${spacesAvailable} spaces available)`) +
      '. Clubworx refuses this booking without saying why; it is not necessarily capacity.'
    );
  }

  const raw = message === null || message === '' ? null : String(message);
  return raw === null
    ? 'Refused by Clubworx, with no message.'
    : `Refused by Clubworx: "${raw}"`;
}

/**
 * A booking id out of a create response, wherever this API chose to put it.
 *
 * Tolerant because the shape of a create response is not something to guess at
 * from a reference that has been wrong twice here. Returned as a string so the
 * id that goes into a URL is the id that came back.
 *
 * @param {unknown} body
 * @returns {string|null}
 */
export function bookingIdOf(body) {
  const id =
    body?.booking_id ??
    body?.id ??
    body?.booking?.booking_id ??
    body?.booking?.id ??
    (Array.isArray(body) ? (body[0]?.booking_id ?? body[0]?.id) : null) ??
    null;
  return id === null || id === undefined || id === '' ? null : String(id);
}

/**
 * Book one student into one event. **One attempt** — retries are the caller's,
 * because a 429 pauses the whole run rather than one row (§11).
 *
 * @param {object} opts
 * @param {{post: Function}} opts.client
 * @param {string} opts.contactKey
 * @param {string|number} opts.eventId
 * @param {number|null} [opts.spacesAvailable] For the spaces refusal's wording.
 * @returns {Promise<{state: 'booked'|'already booked'|'refused'|'failed', event_id: any,
 *   booking_id: string|null, bookingId: string|null, refusal: string|null,
 *   message: string|null, shown: string|null, retryable: boolean,
 *   reason: string|null, unverifiable?: boolean}>}
 */
export async function bookEvent({ client, contactKey, eventId, spacesAvailable = null }) {
  const res = await client.post('bookings', { contact_key: contactKey, event_id: eventId });

  const row = {
    event_id: eventId,
    state: FAILED,
    // The contact this row belongs to travels WITH the row, so a later cancel
    // takes the contact key from the booking rather than from whoever is asking.
    // `DELETE /bookings/:id` needs it, and #50 spent a week on the 401 that a
    // missing one produces; taking it from the row is what makes it impossible
    // to omit or to mismatch against a different student's booking.
    contact_key: contactKey,
    booking_id: null,
    refusal: null,
    message: res.message ?? errorMessageOf(res.body) ?? null,
    shown: null,
    retryable: false,
    reason: null,
  };

  if (res.ok) {
    const id = bookingIdOf(res.body);
    return {
      ...row,
      state: BOOKED,
      booking_id: id,
      message: null,
      // A 200 with no id anywhere is a shape nobody here has seen. The booking
      // is reported as made — the status says so — but it is flagged, because a
      // row with no id cannot be cancelled, by the rollback or by a human.
      ...(id === null ? { unverifiable: true } : {}),
    };
  }

  if (res.status === 400) {
    const kind = classifyRefusal(row.message);

    if (kind === 'already-booked') {
      return {
        ...row,
        state: ALREADY_BOOKED_STATE,
        refusal: kind,
        // No id, deliberately. This booking was not made by this run, so
        // nothing here may cancel it.
        booking_id: null,
        shown: describeRefusal(kind),
      };
    }

    // D8 — never retry a 400. All three known ones are permanent for that
    // attempt, and the fourth kind is unknown by definition.
    return {
      ...row,
      state: REFUSED,
      refusal: kind,
      retryable: false,
      shown: describeRefusal(kind, { message: row.message, spacesAvailable }),
    };
  }

  // 429, 5xx and network errors are the only retryable outcomes (D8). A throttle
  // is told apart because it does not pause a row — it pauses the run.
  return {
    ...row,
    state: FAILED,
    retryable: isRetryable(res),
    reason: upstreamReason(res),
    message: row.message ?? upstreamMessage(res),
    upstreamStatus: res.status,
  };
}

/**
 * Cancel one booking.
 *
 * `contact_key` is required, not optional. Without it Clubworx answers
 * `401 "Authorization failed"` — indistinguishable from a key with no delete
 * permission, and misdiagnosed as exactly that for a week in #50. So a missing
 * contact key is refused **here**, before the network, rather than rediscovered
 * as a mystery 401.
 *
 * @param {object} opts
 * @param {{del: Function}} opts.client
 * @param {string} opts.bookingId
 * @param {string} opts.contactKey
 */
export async function cancelBooking({ client, bookingId, contactKey }) {
  const id = String(bookingId ?? '');
  if (!id) return { ok: false, bookingId: null, reason: 'no booking id to cancel' };
  if (!contactKey) {
    return {
      ok: false,
      bookingId: id,
      reason:
        'refusing to cancel without a contact_key — Clubworx answers 401 "Authorization failed" ' +
        'to that request, which reads like a permissions problem and is not one',
    };
  }

  const res = await client.del(`bookings/${id}`, { contact_key: contactKey });
  return {
    ok: res.ok === true,
    bookingId: id,
    upstreamStatus: res.status ?? null,
    reason: res.ok ? null : (res.message ?? res.bodyText ?? `HTTP ${res.status}`),
  };
}

/**
 * Cancel the bookings **this run** made for one student.
 *
 * The interlock: acts on `booked`, never on `already booked`. See the header.
 * There is no flag to relax it, because D3's rollback runs this with no human
 * present and a flag is the thing a rollback path would set.
 *
 * One failed cancel does not stop the rest. A student half-rolled-back is worse
 * than one fully rolled back, and the failures are reported so a human can
 * finish it.
 *
 * @param {object} opts
 * @param {{del: Function}} opts.client
 * @param {string} [opts.contactKey] The student being rolled back. Used only to
 *   **reject** a row belonging to somebody else; the key actually sent comes
 *   from the row.
 * @param {Array<{event_id: any, state: string, booking_id: string|null,
 *   contact_key: string|null}>} opts.rows
 */
export async function cancelRunBookings({ client, contactKey = null, rows = [] }) {
  const failed = [];
  // The ids, not only the count. A cancel is confirmed by re-reading the
  // contact's bookings and finding them gone (§12, #70), and a count cannot say
  // *which* ids to look for.
  const cancelledIds = [];
  let skipped = 0;

  for (const row of rows) {
    if (row?.state !== BOOKED) {
      // Includes `already booked`, `refused` and anything else. Only a row this
      // run put there may be taken away.
      skipped += 1;
      continue;
    }

    if (!row.booking_id) {
      failed.push({
        event_id: row.event_id,
        booking_id: null,
        reason:
          'booked, but Clubworx returned no booking id, so there is no booking id to cancel — ' +
          'this one has to be undone by hand',
        upstreamStatus: null,
      });
      continue;
    }

    // The contact comes from the **booking row**, not from the caller — the
    // property #70 asks for, and the one `probes/lib/booking.mjs` holds by
    // keeping the contact beside the id it may cancel. A caller-supplied key can
    // be omitted (the 401 that cost #50 a week) or, worse, be a different
    // student's, which would point a DELETE at somebody else's class.
    const rowKey = row.contact_key ?? null;
    if (!rowKey) {
      failed.push({
        event_id: row.event_id,
        booking_id: row.booking_id,
        reason:
          'this booking carries no contact_key of its own, and a cancel will not be sent on a ' +
          'contact key supplied from outside the row',
        upstreamStatus: null,
      });
      continue;
    }
    if (contactKey && rowKey !== contactKey) {
      // A row belonging to a different contact has no business in this student's
      // rollback. Refusing is the only safe reading of a set that should not
      // have been mixed.
      failed.push({
        event_id: row.event_id,
        booking_id: row.booking_id,
        reason:
          'this booking belongs to a different contact than the one being rolled back, so it ' +
          'has not been cancelled',
        upstreamStatus: null,
      });
      continue;
    }

    const res = await cancelBooking({ client, bookingId: row.booking_id, contactKey: rowKey });
    if (res.ok) cancelledIds.push(String(row.booking_id));
    else
      failed.push({
        event_id: row.event_id,
        booking_id: row.booking_id,
        reason: res.reason,
        // Carried so a caller can tell a throttle from a refusal without
        // re-parsing the sentence. §11 pauses the whole run on a 429, and a
        // reason string is the wrong thing to switch a run on.
        upstreamStatus: res.upstreamStatus ?? null,
      });
  }

  return { cancelled: cancelledIds.length, cancelledIds, skipped, failed };
}

/**
 * Read a contact's own bookings — how a booking write is verified.
 *
 * §16: verify a write by re-reading the resource, never by the status code. An
 * accepted-but-silent duplicate looks identical to an idempotent server from the
 * response alone, and this is how #60 established the idempotency in the first
 * place — by counting either side.
 *
 * @param {object} opts
 * @param {{get: Function}} opts.client
 * @param {string} opts.contactKey
 */
export async function readBookings({ client, contactKey }) {
  const res = await client.get('bookings', { contact_key: contactKey });

  if (!res.ok) {
    return {
      ok: false,
      reason: upstreamReason(res),
      message: upstreamMessage(res),
      upstreamStatus: res.status,
      eventIds: [],
      bookingIds: [],
    };
  }

  if (!Array.isArray(res.body)) {
    return {
      ok: false,
      reason: 'upstream-error',
      message: `bookings answered ${res.status} with a body that is not a list`,
      upstreamStatus: res.status,
      eventIds: [],
      bookingIds: [],
    };
  }

  return {
    ok: true,
    // Strings on both sides of every later comparison — Clubworx has sent ids
    // as numbers and as strings, and `42 !== '42'` would report a booking that
    // landed as one that did not.
    eventIds: res.body.map(r => (r?.event_id === undefined ? null : String(r.event_id))),
    bookingIds: res.body.map(r => bookingIdOf(r)).filter(Boolean),
    count: res.body.length,
  };
}
