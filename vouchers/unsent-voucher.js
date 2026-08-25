// vouchers/unsent-voucher.js
// Whether a voucher was supposed to reach someone by email and hasn't.
// Pure on purpose — no DOM, no network — so the rule is unit-testable and the
// three places that render it cannot drift apart.
//
// The canonical definition of "unsent voucher" lives in the vouchers repo,
// docs/CONTEXT.md. Kept in step with the Worker, which decides the underlying
// columns: email_sent is set by any successful send, original or resend, and
// send_last_error carries the reason a send failed.

// An unsent voucher is still a perfectly good voucher. Nothing here says
// anything about validity — it is active and redeemable at the desk whether or
// not the email arrived, and a member should never lose an entitlement over a
// stale address. This answers one question only: does someone still need to be
// sent this?
export function isUnsent(voucher) {
  if (!voucher) return false;

  // A physical card is handed over at the counter and no email was ever due, so
  // it carries email_sent: false permanently and correctly. Without this every
  // voucher issued at the front desk would flag.
  if (voucher.is_physical) return false;

  // Nothing to send to, and nothing a staff member could resend. The detail
  // view already says so in its own line; two messages about one absent address
  // would just compete.
  if (!voucher.customer_email) return false;

  return !voucher.email_sent;
}

// The Worker has already turned the provider's response into something a staff
// member can act on (sendVoucherEmail in the payments Worker). Pass it through
// rather than replacing it with a generic line: "the address was rejected as
// invalid" tells someone what to do next, and "it failed" does not.
//
// Empty when there is no recorded reason — an older row, or a send that never
// got far enough to record one — so callers can hide the line rather than
// render an empty one.
export function unsentReason(voucher) {
  if (!voucher) return '';
  return typeof voucher.send_last_error === 'string' ? voucher.send_last_error.trim() : '';
}
