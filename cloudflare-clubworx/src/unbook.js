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
 * A set spanning two contacts is refused before anything is sent. The reason is
 * the request budget of a single invocation, not tidiness.
 *
 * §6 sizes a run at **25 students × 6 sessions**. Cancelling one is therefore up
 * to 150 `DELETE`s plus a verifying re-read per student, and this Worker paces
 * at ~800 ms — well over two minutes in one request, before the Workers
 * per-invocation subrequest ceiling is even considered. That is the same shape
 * D1 rejected for the run itself, with the same unrecoverable failure mode:
 * **the writes land and the log is lost.** The page already loops per student to
 * apply, holds each student's rows in `localStorage` as they land (D10), and
 * cancels by looping the same way.
 *
 * This is a different check from the one `cancelRunBookings` already makes, not
 * a second copy of it: that one rejects a **stray row** inside one student's
 * rollback, this one rejects a **set spanning students** before any of it runs.
 * Both refuse; neither cancels the wrong thing.
 *
 * ---------------------------------------------------------------------------
 * What this module does NOT do
 * ---------------------------------------------------------------------------
 * The interlock, the `contact_key`-from-the-row rule, the throttle halt and the
 * verifying re-read all live in `cancelRunBookings`, because **D3's automatic
 * rollback needs every one of them and it is not a route.** This module is the
 * route's own job and nothing else: validate the body, refuse a set it cannot
 * verify, and turn the tally into an outcome and an HTTP status.
 *
 * Putting the verification here instead would have left the caller with no human
 * present — the rollback — trusting a `200`, which is the exact thing #60 proved
 * cannot be trusted.
 */

import { BOOKED, cancelRunBookings } from './bookings.js';
import { countedClient } from './clubworx.js';

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
 * Cancel the bookings one run made for one student, and report what is known.
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

  // The contacts this call would touch — from the rows this run actually booked,
  // plus whatever the caller claims. More than one and nothing is sent; see the
  // header for why the boundary is one student.
  const keys = new Set(
    rows.filter(row => row?.state === BOOKED).map(row => row?.contact_key).filter(Boolean),
  );
  if (contactKey) keys.add(contactKey);

  if (keys.size > 1) {
    return refusal({
      reason: 'mixed-contacts',
      message:
        'these booking rows belong to more than one contact. One call cancels one student — ' +
        'a whole run in one request is the multi-minute response whose failure mode is writes ' +
        'landed and log lost',
    });
  }

  const key = keys.size === 1 ? [...keys][0] : null;
  const { state, client: tracked } = countedClient(client);

  // The interlock, the contact-from-the-row rule, the throttle halt and the
  // verifying re-read are all in here. This module does not repeat any of them.
  const run = await cancelRunBookings({ client: tracked, contactKey: key, rows });

  // Rows this run booked, derived from the tally rather than re-filtered — the
  // interlock's own count of what it passed over is the authority on that.
  const actionable = rows.length - run.skipped;

  const base = {
    contact_key: key,
    cancelled: run.cancelled,
    cancelledIds: run.cancelledIds,
    skipped: run.skipped,
    failed: run.failed,
    stillBooked: run.stillBooked,
    verified: run.verified,
    requests: state.requests,
  };

  if (actionable === 0) {
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
    };
  }

  // §11 — a throttle pauses the whole run, not one row, because the allowance is
  // gym-wide. It outranks every other reason for that reason alone.
  const reason = run.throttled ? 'throttled' : null;
  const throttleMessage =
    'Clubworx is busy — this can be caused by another system, not this page. Try again shortly.';

  if (run.cancelled === 0) {
    return {
      ...base,
      ok: false,
      outcome: 'failed',
      reason: reason ?? 'cancel-failed',
      message: run.throttled
        ? throttleMessage
        : `none of the ${actionable} booking(s) could be cancelled — they are still there`,
    };
  }

  if (run.stillBooked.length > 0) {
    return {
      ...base,
      ok: false,
      outcome: 'still-booked',
      reason: reason ?? run.verifyReason,
      message:
        `${run.stillBooked.length} booking(s) Clubworx accepted a cancellation for are still ` +
        'there on a re-read. The 200 was not the truth; these have to be removed by hand.',
    };
  }

  if (!run.verified) {
    // Cancels were accepted, and nothing here knows whether they took. Reported
    // as unconfirmed rather than as done, because the two send an operator to
    // different places.
    return {
      ...base,
      ok: false,
      outcome: 'unverified',
      reason: reason ?? run.verifyReason,
      message:
        `${run.cancelled} cancellation(s) were accepted but could not be confirmed by re-reading ` +
        'this contact’s bookings' +
        (run.verifyMessage ? `: ${run.verifyMessage}` : '') +
        '. A DELETE that answers 200 and changes nothing looks identical from here, so this is ' +
        'reported as unconfirmed rather than as done — check the student in Clubworx.',
    };
  }

  if (run.failed.length > 0) {
    return {
      ...base,
      ok: false,
      outcome: 'partial',
      reason: reason ?? 'cancel-failed',
      message:
        `${run.cancelled} booking(s) cancelled and confirmed gone; ${run.failed.length} could not ` +
        'be cancelled and need removing by hand.' +
        (run.throttled ? ` ${throttleMessage}` : ''),
    };
  }

  return {
    ...base,
    ok: true,
    outcome: 'cancelled',
    reason: null,
    message: `${run.cancelled} booking(s) cancelled, confirmed by re-reading this contact’s bookings.`,
  };
}
