/**
 * The membership write path: `POST /api/v2/memberships`.
 *
 * The fourth way out to Clubworx, beside `lib/http.mjs` (GET), `lib/write.mjs`
 * (creates a contact) and `lib/booking.mjs` (books and cancels). Same structural
 * argument as the others: a probe that does not import this module cannot
 * assign a membership, and that is a property of the script rather than a claim
 * about it.
 *
 * Assigning a membership is treated as **irreversible**. The reference exposes
 * list and create for memberships and **no delete**, so a School Pass given to
 * the wrong contact is another permanent mark on a real person's record — the
 * same class of mistake as creating a contact, and guarded the same way:
 *
 *   1. `live` defaults to false, so an import or a forgotten flag costs nothing.
 *   2. The contact must be one of the recognised probe contacts, checked before
 *      the network is touched.
 *
 * The body is **form-encoded**, not JSON. The reference documents
 * `account_key=…&contact_key=…&membership_plan_id=…&start_date=…`, and #50
 * learned the hard way that guessing a request's shape here produces a status
 * code that looks like something else entirely.
 */

import { buildUrl, redact } from '../../src/request.js';
import { rateLimitHeaders } from './report.mjs';

/**
 * Refuse to assign a membership to anything but a known probe contact.
 *
 * Same reasoning as `assertProbeBooking`: a membership payload carries an
 * opaque `contact_key` and no name, dob or email, so there is nothing in its
 * shape to recognise. The control has to be an allowlist built from rows that
 * already passed the identity guard.
 *
 * @param {{contact_key?: string, membership_plan_id?: unknown}} membership
 * @param {Set<string>|Array<string>} allowedContactKeys
 */
export function assertProbeMembership(membership, allowedContactKeys) {
  const allowed =
    allowedContactKeys instanceof Set ? allowedContactKeys : new Set(allowedContactKeys ?? []);
  const { contact_key, membership_plan_id } = membership ?? {};

  if (allowed.size === 0) {
    throw new Error(
      'refusing to assign a membership: no probe contacts were recognised, so there is nobody this probe may assign one to',
    );
  }
  if (typeof contact_key !== 'string' || !contact_key) {
    throw new Error(
      `refusing to assign a membership without a contact_key (got ${JSON.stringify(contact_key)})`,
    );
  }
  if (!allowed.has(contact_key)) {
    throw new Error(
      `refusing to assign a membership to a contact that is not a recognised probe contact (${contact_key}) — ` +
        'memberships have no delete endpoint, so this would be permanent',
    );
  }
  if (membership_plan_id === undefined || membership_plan_id === null || membership_plan_id === '') {
    throw new Error(
      `refusing to assign a membership without a membership_plan_id (got ${JSON.stringify(membership_plan_id)})`,
    );
  }

  return membership;
}

/**
 * @param {object} opts
 * @param {string} opts.accountKey
 * @param {Set<string>|Array<string>} [opts.allowedContactKeys]
 * @param {boolean} [opts.live] Must be explicitly true before anything is assigned.
 * @param {typeof fetch} [opts.fetchImpl]
 */
export function createMembershipAssigner({
  accountKey,
  allowedContactKeys = [],
  live = false,
  fetchImpl = fetch,
}) {
  const allowed =
    allowedContactKeys instanceof Set ? allowedContactKeys : new Set(allowedContactKeys);

  /**
   * @param {{contact_key: string, membership_plan_id: string|number, start_date?: string}} membership
   */
  const assign = async membership => {
    const url = buildUrl({ path: 'memberships', accountKey });
    const safeUrl = redact(url, accountKey);

    // Before the live check, so a dry run exercises the guard rather than only
    // the plumbing.
    let form;
    try {
      assertProbeMembership(membership, allowed);
      form = {
        account_key: accountKey,
        contact_key: membership.contact_key,
        membership_plan_id: String(membership.membership_plan_id),
        ...(membership.start_date ? { start_date: membership.start_date } : {}),
      };
    } catch (err) {
      return {
        url: safeUrl,
        status: null,
        ms: 0,
        headers: {},
        contentType: null,
        body: null,
        bodyText: null,
        error: null,
        refused: err.message,
        dryRun: !live,
      };
    }

    // What a dry run reports must not include the key, even though the real
    // request has to send it.
    const { account_key, ...shown } = form;

    if (!live) {
      return {
        url: safeUrl,
        status: null,
        ms: 0,
        headers: {},
        contentType: null,
        body: null,
        bodyText: null,
        error: null,
        refused: null,
        dryRun: true,
        wouldSend: shown,
      };
    }

    assign.writes += 1;
    const started = performance.now();

    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(form).toString(),
      });
      const ms = Math.round(performance.now() - started);
      const bodyText = await res.text();

      let body = null;
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = null;
      }

      return {
        url: safeUrl,
        status: res.status,
        ms,
        headers: rateLimitHeaders(res.headers),
        contentType: res.headers.get?.('content-type') ?? null,
        body,
        bodyText: body === null ? redact(bodyText, accountKey).slice(0, 500) : null,
        error: null,
        refused: null,
        dryRun: false,
        sent: shown,
      };
    } catch (err) {
      // A failed assignment may still have landed. Memberships have no delete,
      // so this is reported as "may exist" rather than as a no-op.
      return {
        url: safeUrl,
        status: null,
        ms: Math.round(performance.now() - started),
        headers: {},
        contentType: null,
        body: null,
        bodyText: null,
        error: redact(err.code ?? err.message ?? 'unknown error', accountKey),
        refused: null,
        dryRun: false,
        sent: shown,
      };
    }
  };

  assign.writes = 0;
  return { assign };
}
