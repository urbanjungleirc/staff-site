// vouchers/expiry-flag.js
// Whether a voucher is close enough to expiry that the detail view should say
// so. Pure on purpose — no DOM, no clock — so the caller supplies "today" and
// the boundaries are unit-testable.
//
// This deliberately answers the same question, the same way, as the dashboard's
// "expiring in the next 30 days" counter, which the payments Worker computes in
// GET /v1/vouchers/stats. Two places on the same page disagreeing about what
// "soon" means is worse than only one of them saying anything, so the window and
// the predicate below are both matched to it. If either moves, the Worker's
// expiringSoonCount moves with it.

export const EXPIRING_SOON_DAYS = 30;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// 'YYYY-MM-DD' is fixed-width and zero-padded, so a string compare is a date
// compare — the same reason the search filters use one. UTC arithmetic is safe
// here because Western Australia has never observed daylight saving: the Perth
// date 30×24h from now (what the Worker computes) and today's Perth date plus
// 30 calendar days are always the same day.
export function addDays(isoDate, days) {
  if (!ISO_DATE.test(isoDate)) return '';
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function isExpiringSoon(voucher, today) {
  if (!voucher || !ISO_DATE.test(String(today))) return false;

  // Cancelled and fully redeemed vouchers carry their own status and are not
  // usable, so they never read as expiring — matching the Worker, which counts
  // only status=eq.active. The stored status is NOT trusted for expiry itself:
  // the book is full of rows still marked 'active' that lapsed years ago, and
  // the window below is what excludes them.
  if (voucher.status !== 'active') return false;

  // The column is a date, but tolerate a timestamp the way the rest of the page
  // does rather than silently dropping the flag if the API ever sends one.
  const expiry = String(voucher.expiry_date || '').slice(0, 10);
  if (!ISO_DATE.test(expiry)) return false;

  // >= today, not > : a voucher expiring today is redeemable all day, so it is
  // still expiring rather than already expired. Same boundary as the Worker's.
  return expiry >= today && expiry <= addDays(today, EXPIRING_SOON_DAYS);
}
