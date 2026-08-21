/**
 * `POST /unbook` — the only reversal this system has.
 *
 * staff-site#70. Design: `docs/superpowers/specs/2026-08-19-school-group-booking-design.md` §12.
 *
 * ---------------------------------------------------------------------------
 * What this can and cannot take back
 * ---------------------------------------------------------------------------
 * | Record | Reversible? |
 * |---|---|
 * | **Booking** | **Yes** — `DELETE /bookings/:id`, measured in #60 |
 * | **Contact** | **No.** 42 endpoints reviewed, no delete anywhere. Removable only by hand in the Clubworx UI, against a ~60,000-profile database |
 * | **School Pass membership** | **No.** None appears in the reference and none was attempted. It lapses at `expiration_date` |
 *
 * So a caller of this route gets its bookings back and nothing else, and the
 * page must never imply otherwise — **D12, there is no button called "Undo"**.
 * A student left with a contact and a pass and no bookings is *stranded*, and
 * under D3's rollback that is a routine outcome rather than an edge case.
 *
 * ---------------------------------------------------------------------------
 * The interlock, which is why this is not just a loop over `DELETE`
 * ---------------------------------------------------------------------------
 * **Never cancel a booking marked `already booked`.** Booking is idempotent, so
 * a re-run marks rows `already booked` — and a cancel scoped to the whole row
 * set would delete bookings *this run did not create*, possibly a session a real
 * member booked themselves. #50 identified that as the worst outcome available
 * on this map.
 *
 * The interlock lives in `cancelRunBookings`, shared with D3's automatic
 * rollback inside `POST /student`. It is not re-implemented here, and there is
 * no flag to relax it: a rollback path with no human present is exactly the
 * caller that would set one.
 *
 * ---------------------------------------------------------------------------
 * `contact_key` is not optional, and it comes from the booking
 * ---------------------------------------------------------------------------
 * `DELETE /api/v2/bookings/:id` requires `contact_key` **as well as**
 * `account_key`, form-encoded in the body. Without it the answer is
 * `401 "Authorization failed"` — indistinguishable from a key with no delete
 * permission, and misdiagnosed as exactly that for a week in #50, which reported
 * that bookings could not be deleted at all. **A permissions-shaped error meant
 * a missing parameter.**
 *
 * So the key sent is taken from the **booking row**, never from the caller. A
 * caller-supplied key can be forgotten (that 401), or — worse — be a different
 * student's, which points a `DELETE` at somebody else's class. The caller's
 * `contact_key`, when it sends one, is used only to *reject* a row that does not
 * match it.
 *
 * ---------------------------------------------------------------------------
 * One contact per call
 * ---------------------------------------------------------------------------
 * A mixed set is refused before anything is sent. Two reasons, and the first is
 * the load-bearing one:
 *
 *   - **Verification is a re-read of one contact's bookings.** A mixed set could
 *     only be half-verified, and a half-verified cancel reported as done is the
 *     failure this route exists to prevent.
 *   - **D1 — the browser drives, one Worker call per student.** The human
 *     "Cancel bookings from this run" control spans a run, but it loops the same
 *     way the run itself does. A whole-run cancel in one invocation is the
 *     multi-minute one-shot response D1 rejected, with the same unrecoverable
 *     failure mode: writes landed, log lost.
 *
 * ---------------------------------------------------------------------------
 * A 200 proves nothing. The re-read does
 * ---------------------------------------------------------------------------
 * #60 confirmed the reversal by re-count — 1 booking before, 0 after —
 * precisely because a status code cannot show a `DELETE` that was accepted and
 * changed nothing. So every cancel this module reports is checked against
 * `GET /bookings?contact_key=`, and an id still present comes back as
 * `still-booked` rather than as cancelled.
 *
 * The re-read is skipped only when nothing was cancelled: it costs a request
 * against a gym-wide allowance and there is no claim to check.
 */

import { BOOKED, cancelRunBookings, readBookings } from './bookings.js';
import { upstreamMessage } from './upstream.js';

/**
 * Wrap the client so every call it makes is counted.
 *
 * The same wrapper `student.js` uses, and for the same reason: the allowance is
 * gym-wide (one key per gym, #47), so what a cancel costs is worth reporting
 * rather than estimating.
 */
function counted(client) {
  const state = { requests: 0 };
  const tick = fn => (...args) => {
    state.requests += 1;
    return fn(...args);
  };
  return {
    state,
    client: {
      get: tick(client.get.bind(client)),
      del: tick(client.del.bind(client)),
    },
  };
}

/** Refused before anything was sent, so there is nothing to report but the reason. */
const refusal = ({ reason, message }) => ({
  ok: false,
  outcome: 'refused',
  reason,
  message,
  contact_key: null,
  cancelled: 0,
  cancelledIds: [],
  skipped: 0,
  failed: [],
  stillBooked: [],
  verified: false,
  requests: 0,
});

/**
 * Cancel the bookings one run made for one student, and confirm they are gone.
 *
 * @param {object} opts
 * @param {{get: Function, del: Function}} opts.client
 * @param {string|null} [opts.contactKey] The student being rolled back. Used
 *   only to **reject** a row belonging to somebody else; the key actually sent
 *   comes from the row.
 * @param {Array<{event_id: any, state: string, booking_id: string|null,
 *   contact_key: string|null}>|null} opts.rows The result rows from this run,
 *   exactly as `POST /student` handed them back.
 * @returns {Promise<{ok: boolean, outcome: 'refused'|'nothing-to-cancel'|'cancelled'|
 *   'partial'|'failed'|'still-booked'|'unverified', reason: string|null,
 *   message: string|null, contact_key: string|null, cancelled: number,
 *   cancelledIds: string[], skipped: number, failed: object[],
 *   stillBooked: string[], verified: boolean, requests: number}>}
 */
export async function unbookRun({ client, contactKey = null, rows = null }) {
  if (!Array.isArray(rows)) {
    return refusal({
      reason: 'bad-request',
      message: 'a list of booking rows from this run is required',
    });
  }

  // Only rows this run put in `booked` are ever acted on. Everything else —
  // `already booked` above all — is counted and left where it is.
  const actionable = rows.filter(row => row?.state === BOOKED);

  // The contacts this call would touch, from the rows themselves plus whatever
  // the caller claims. More than one and nothing is sent: see the header.
  const keys = new Set(actionable.map(row => row?.contact_key).filter(Boolean));
  if (contactKey) keys.add(contactKey);

  if (keys.size > 1) {
    return refusal({
      reason: 'mixed-contacts',
      message:
        'these booking rows belong to more than one contact. One call cancels one student, ' +
        'because the cancellation is confirmed by re-reading that one contact’s bookings',
    });
  }

  const key = keys.size === 1 ? [...keys][0] : null;
  const { state, client: tracked } = counted(client);

  const run = await cancelRunBookings({ client: tracked, contactKey: key, rows });

  const base = {
    contact_key: key,
    cancelled: run.cancelled,
    cancelledIds: run.cancelledIds,
    skipped: run.skipped,
    failed: run.failed,
    stillBooked: [],
  };

  if (actionable.length === 0) {
    // Nothing this run booked, so nothing to take away. Not an error: a re-run
    // marks every row `already booked`, and cancelling that set is the one thing
    // the interlock exists to stop.
    return {
      ...base,
      ok: true,
      outcome: 'nothing-to-cancel',
      reason: null,
      message:
        run.skipped > 0
          ? `${run.skipped} booking(s) were not made by this run, so none has been cancelled`
          : 'there were no bookings from this run to cancel',
      verified: false,
      requests: state.requests,
    };
  }

  // §11 — a throttle pauses the whole run, not one row, because the allowance is
  // gym-wide. It outranks every other reason for that reason alone.
  const throttled = run.failed.some(f => f.upstreamStatus === 429);

  if (run.cancelledIds.length === 0) {
    return {
      ...base,
      ok: false,
      outcome: 'failed',
      reason: throttled ? 'throttled' : 'cancel-failed',
      message: throttled
        ? 'Clubworx is busy — this can be caused by another system, not this page. Try again shortly.'
        : `none of the ${actionable.length} booking(s) could be cancelled — they are still there`,
      verified: false,
      requests: state.requests,
    };
  }

  // -------------------------------------------------------------------------
  // Verify by re-reading, never by the status code (§12, #60).
  // -------------------------------------------------------------------------
  const held = await readBookings({ client: tracked, contactKey: key });

  if (!held.ok) {
    return {
      ...base,
      ok: false,
      outcome: 'unverified',
      reason: 'bookings-unread',
      message:
        `${run.cancelledIds.length} cancellation(s) were accepted but could not be confirmed by ` +
        're-reading this contact’s bookings: ' +
        (upstreamMessage(held) ?? `HTTP ${held.upstreamStatus}`) +
        '. A DELETE that answers 200 and changes nothing looks identical from here, so this is ' +
        'reported as unconfirmed rather than as done — check the student in Clubworx.',
      verified: false,
      requests: state.requests,
    };
  }

  const stillHeld = new Set(held.bookingIds.map(String));
  const stillBooked = run.cancelledIds.filter(id => stillHeld.has(String(id)));

  if (stillBooked.length > 0) {
    return {
      ...base,
      ok: false,
      outcome: 'still-booked',
      reason: 'cancel-not-applied',
      stillBooked,
      message:
        `${stillBooked.length} booking(s) Clubworx accepted a cancellation for are still there on ` +
        'a re-read. The 200 was not the truth; these have to be removed by hand.',
      verified: false,
      requests: state.requests,
    };
  }

  if (run.failed.length > 0) {
    return {
      ...base,
      ok: false,
      outcome: 'partial',
      reason: throttled ? 'throttled' : 'cancel-failed',
      message:
        `${run.cancelled} booking(s) cancelled and confirmed gone; ${run.failed.length} could not ` +
        'be cancelled and need removing by hand.',
      verified: true,
      requests: state.requests,
    };
  }

  return {
    ...base,
    ok: true,
    outcome: 'cancelled',
    reason: null,
    message: `${run.cancelled} booking(s) cancelled, confirmed by re-reading this contact’s bookings.`,
    verified: true,
    requests: state.requests,
  };
}
