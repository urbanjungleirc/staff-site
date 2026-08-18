/**
 * The booking write path: `POST /bookings` and `DELETE /bookings/:id`.
 *
 * A third file beside `lib/http.mjs` (GET only) and `lib/write.mjs` (creates
 * contacts), for the same structural reason as the split between those two: a
 * probe that does not import this module cannot book or cancel anything, and
 * that is a property of the script rather than a claim about it.
 *
 * Bookings differ from contacts in both directions, and the guards here follow
 * the difference rather than copying `lib/write.mjs`:
 *
 *   - A booking **is** reversible (`DELETE /bookings/:id`, ACCESS.md section 4),
 *     so the cost of a mistaken create is lower than it is for a contact.
 *   - But `DELETE` is a verb no probe has had before, and it points at a
 *     production database holding real customers' bookings. **Cancelling
 *     somebody's real class is a worse outcome than any accidental create on
 *     this map**, and unlike a contact it is not merely untidy — a member turns
 *     up to a session they are no longer booked into.
 *
 * So the asymmetry is deliberate: `book` is guarded by an allowlist of probe
 * contact keys, and `cancel` refuses any booking id this module did not either
 * create itself or have explicitly vouched for. There is no way to hand it an
 * arbitrary id.
 */

import { buildUrl, redact } from './request.mjs';
import { rateLimitHeaders } from './report.mjs';

/** Fields that exist for the write-up, not for Clubworx. */
const BOOKKEEPING = new Set(['label', 'why']);

const payloadOf = booking =>
  Object.fromEntries(Object.entries(booking).filter(([name]) => !BOOKKEEPING.has(name)));

/**
 * Refuse to book anything that is not one of the known probe contacts.
 *
 * `assertProbeIdentity` cannot do this job. It validates a contact's *shape* —
 * name, dob, email — and a booking payload carries none of those, only an
 * opaque `contact_key`. There is nothing in a UUID to recognise, so the control
 * has to be an allowlist supplied by the caller, built from rows that already
 * passed `isProbeRow`.
 *
 * @param {{contact_key?: string, event_id?: unknown}} booking
 * @param {Set<string>|Array<string>} allowedContactKeys
 */
export function assertProbeBooking(booking, allowedContactKeys) {
  const allowed = allowedContactKeys instanceof Set ? allowedContactKeys : new Set(allowedContactKeys ?? []);
  const { contact_key, event_id } = booking ?? {};

  if (allowed.size === 0) {
    throw new Error(
      'refusing to book: no probe contacts were recognised, so there is no contact this probe may book',
    );
  }
  if (typeof contact_key !== 'string' || !contact_key) {
    throw new Error(`refusing to book without a contact_key (got ${JSON.stringify(contact_key)})`);
  }
  if (!allowed.has(contact_key)) {
    // The whole point of the control: a key that did not come out of the
    // identity-filtered search belongs to somebody real.
    throw new Error(
      `refusing to book a contact that is not a recognised probe contact (${contact_key}) — ` +
        'this key did not come from a row that passed the identity guard',
    );
  }
  if (event_id === undefined || event_id === null || event_id === '') {
    throw new Error(`refusing to book without an event_id (got ${JSON.stringify(event_id)})`);
  }

  return booking;
}

/**
 * @param {object} opts
 * @param {string} opts.accountKey
 * @param {Set<string>|Array<string>} [opts.allowedContactKeys] Probe contacts this may book.
 * @param {boolean} [opts.live] Must be explicitly true before anything is booked or cancelled.
 * @param {typeof fetch} [opts.fetchImpl]
 */
export function createBooker({ accountKey, allowedContactKeys = [], live = false, fetchImpl = fetch }) {
  const allowed = allowedContactKeys instanceof Set ? allowedContactKeys : new Set(allowedContactKeys);

  /**
   * Booking ids this module is willing to DELETE, each mapped to the contact
   * that holds it.
   *
   * Populated by `book` on success, and by `allowCancel` for bookings an
   * earlier run left behind. Nothing else can add to it, so `cancel` cannot be
   * pointed at a real customer's booking even by a runner bug.
   *
   * It is a map rather than a set because `DELETE /bookings/:id` **requires
   * `contact_key`** as well as the id — see `cancel`. Keeping the contact
   * beside the id means the caller cannot supply a mismatched one.
   */
  const cancellable = new Map();

  const send = async ({ method, path, payload, form }) => {
    const url = buildUrl({ path, accountKey });
    const safeUrl = redact(url, accountKey);
    const started = performance.now();

    try {
      const res = await fetchImpl(url, {
        method,
        headers: {
          Accept: 'application/json',
          ...(payload ? { 'Content-Type': 'application/json' } : {}),
          ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
        // The reference documents DELETE's parameters as a form-encoded body,
        // not query string. Sending them the other way is how this probe first
        // read a missing parameter as a permissions failure.
        ...(form ? { body: new URLSearchParams(form).toString() } : {}),
      });
      const ms = Math.round(performance.now() - started);
      const bodyText = await res.text();

      // A rejection for "no membership" is the answer to question 2, and it may
      // well arrive as HTML from a WAF or a validation layer. Parsing must not
      // decide whether the sample survives.
      let body = null;
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = null;
      }

      return {
        url: safeUrl,
        method,
        status: res.status,
        ms,
        headers: rateLimitHeaders(res.headers),
        contentType: res.headers.get?.('content-type') ?? null,
        body,
        bodyText: body === null ? redact(bodyText, accountKey).slice(0, 500) : null,
        error: null,
        refused: null,
        dryRun: false,
        ...(payload ? { sent: payload } : {}),
      };
    } catch (err) {
      // The url is interpolated into node's own connection errors. A failed
      // booking may still have landed, which is why the caller treats this as
      // "may exist" rather than "did not happen".
      return {
        url: safeUrl,
        method,
        status: null,
        ms: Math.round(performance.now() - started),
        headers: {},
        contentType: null,
        body: null,
        bodyText: null,
        error: redact(err.code ?? err.message ?? 'unknown error', accountKey),
        refused: null,
        dryRun: false,
        ...(payload ? { sent: payload } : {}),
      };
    }
  };

  const inert = ({ method, url, extra = {} }) => ({
    url,
    method,
    status: null,
    ms: 0,
    headers: {},
    contentType: null,
    body: null,
    bodyText: null,
    error: null,
    refused: null,
    dryRun: true,
    ...extra,
  });

  /**
   * Book a probe contact into an event.
   *
   * @param {{contact_key: string, event_id: string|number, label?: string, why?: string}} booking
   */
  const book = async booking => {
    const safeUrl = redact(buildUrl({ path: 'bookings', accountKey }), accountKey);

    // Before the live check, so a dry run exercises the guard rather than only
    // the plumbing — the same order `lib/write.mjs` uses.
    let payload;
    try {
      assertProbeBooking(booking, allowed);
      payload = payloadOf(booking);
    } catch (err) {
      return { ...inert({ method: 'POST', url: safeUrl }), refused: err.message, dryRun: !live };
    }

    if (!live) return inert({ method: 'POST', url: safeUrl, extra: { wouldSend: payload } });

    book.writes += 1;
    const res = await send({ method: 'POST', path: 'bookings', payload });

    const id = bookingIdOf(res.body);
    // Only a booking this run created may later be cancelled, and only for the
    // contact it was created for.
    if (id) cancellable.set(String(id), payload.contact_key);

    return { ...res, bookingId: id };
  };

  /**
   * Cancel a booking — but only one this module knows to be the probe's own.
   *
   * `DELETE /api/v2/bookings/:id` requires **`contact_key` as well as
   * `account_key`**, and the reference puts both in a form-encoded body. Omit
   * the contact and it answers `401 "Authorization failed"` — which reads
   * exactly like a key without delete permission, and was misdiagnosed as one
   * on the first #50 run. The contact is therefore taken from `cancellable`
   * rather than from the caller: it cannot be forgotten, and it cannot be a
   * different contact's.
   *
   * @param {string|number} bookingId
   */
  const cancel = async bookingId => {
    const id = String(bookingId ?? '');
    const safeUrl = redact(buildUrl({ path: `bookings/${id}`, accountKey }), accountKey);

    if (!cancellable.has(id)) {
      return {
        ...inert({ method: 'DELETE', url: safeUrl }),
        refused:
          `refusing to cancel booking ${JSON.stringify(bookingId)} — this probe did not create it ` +
          'and it was not vouched for as a probe contact’s booking. Cancelling a real ' +
          'customer’s class is the worst outcome available on this map.',
        dryRun: !live,
      };
    }

    const contact_key = cancellable.get(id);

    if (!live) {
      return inert({ method: 'DELETE', url: safeUrl, extra: { wouldCancel: id, wouldSend: { contact_key } } });
    }

    cancel.writes += 1;
    const res = await send({
      method: 'DELETE',
      path: `bookings/${id}`,
      form: { account_key: accountKey, contact_key },
    });
    return { ...res, bookingId: id };
  };

  /**
   * Vouch for a booking id found by searching a probe contact's own bookings.
   *
   * The cleanup path needs this: a booking left behind by an earlier run was
   * not created by *this* process, so `cancellable` does not hold it. The
   * caller must have read it out of `GET /bookings?contact_key=<a probe
   * contact>`, which is why the contact key is required here rather than
   * assumed — an id alone would let any booking through.
   *
   * @param {string|number} bookingId
   * @param {string} contactKey The probe contact whose bookings this id came from.
   */
  const allowCancel = (bookingId, contactKey) => {
    if (!allowed.has(contactKey)) {
      throw new Error(
        `refusing to vouch for booking ${bookingId}: ${contactKey} is not a recognised probe contact`,
      );
    }
    cancellable.set(String(bookingId), contactKey);
    return bookingId;
  };

  book.writes = 0;
  cancel.writes = 0;

  return { book, cancel, allowCancel, cancellable };
}

/**
 * A booking id out of a create response, wherever this API chose to put it.
 *
 * `run-49.mjs` needed the same tolerance for `contact_key`: the reference is
 * incomplete, and the shape of a create response is not something to guess at
 * from documentation that has already been wrong twice on this map.
 *
 * @param {unknown} body
 */
export function bookingIdOf(body) {
  return (
    body?.booking_id ??
    body?.id ??
    body?.booking?.booking_id ??
    body?.booking?.id ??
    (Array.isArray(body) ? (body[0]?.booking_id ?? body[0]?.id) : null) ??
    null
  );
}
