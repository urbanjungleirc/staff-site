// Pure derivations behind deposits.html (staff-site#154, spec vouchers#100).
//
// The page is a read-only list of every group-booking deposit, straight from
// GET /v1/staff/deposits through the payments proxy. What it decides — which
// group a row lands in, the order within a group, what each email-state cell
// says, where the payment link goes — lives here so it can be tested without
// a browser. The page imports this and publishes it as `window.depositLogic`,
// the same seam as vouchers/unsubscribes-logic.js. Nothing here touches the
// DOM, Alpine, or the network.
//
// Row shape is the Worker's DEPOSIT_LIST_COLUMNS (payments-worker
// src/deposit-list.js). The fields that matter to the rules:
//   source          'webhook' | 'import' — an imported row's null email
//                   timestamps mean "not applicable", never "failed"
//   status          'pending' | 'fulfilled' | 'failed' — anything but
//                   fulfilled is a paid deposit that was never recorded
//   *_email_sent_at null until the provider accepted the email
//   *_email_send_state  null | 'transient' | 'permanent', written by the
//                   daily retry job; the reason is in last_error

const PERTH = 'Australia/Perth';

// en-CA gives ISO order (YYYY-MM-DD) from Intl without string surgery.
const PERTH_ISO_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: PERTH, year: 'numeric', month: '2-digit', day: '2-digit',
});
// Numeric parts only from Intl; month and weekday names are spelled here.
// ICU's en-AU short month flipped from "Sep" to "Sept" between releases, so a
// name from Intl would render differently per browser and per Node version.
const PERTH_PARTS = new Intl.DateTimeFormat('en-AU', {
  timeZone: PERTH, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
});
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONEY = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' });

export function perthToday(now = new Date()) {
  return PERTH_ISO_DATE.format(now);
}

// "Upcoming" is an event today or later in Perth; "past" is everything else
// with a date. A row with no event date was paid but never recorded (a failed
// or pending claim) — it goes to the top of upcoming, because burying the one
// row that needs a human under past is the wrong kind of quiet.
//
// Both groups are newest PAID first (created_at), which is the API's order too;
// sorting here means the page does not depend on the transport preserving it.
export function groupDeposits(rows, today) {
  const byPaidDesc = (a, b) =>
    String(b.created_at || '').localeCompare(String(a.created_at || '')) || String(b.id).localeCompare(String(a.id));

  const unrecorded = rows.filter((r) => !r.event_date).sort(byPaidDesc);
  const dated = rows.filter((r) => r.event_date);

  return {
    upcoming: [...unrecorded, ...dated.filter((r) => r.event_date >= today).sort(byPaidDesc)],
    past: dated.filter((r) => r.event_date < today).sort(byPaidDesc),
  };
}

// One line per email, in staff vocabulary, and the tone the page paints it
// in. `which` is 'staff' or 'customer'. The tone is decided here rather than
// re-read off the text by the page, so a wording change cannot silently drop
// the colour.
function emailStatus(row, which) {
  if (row.source === 'import') return { text: 'Not applicable — imported from the Sheet', tone: 'na' };
  if (row.status !== 'fulfilled') return { text: 'Not sent — deposit not recorded', tone: 'unsent' };
  if (row[`${which}_email_sent_at`]) return { text: 'Sent', tone: 'sent' };

  // last_error is one column shared by fulfilment and both emails, so the
  // reason shown here can be the other email's. The row has nothing finer.
  const reason = row.last_error || 'no reason recorded';
  const parts = [`Not sent — ${reason}`];
  if (row[`${which}_email_send_state`] === 'permanent') {
    // The daily job gave up. For the customer copy it also told frontdesk,
    // once — say so, so nobody sends a second heads-up.
    if (which === 'customer' && row.undeliverable_notice_sent_at) parts.push('frontdesk notified');
  } else {
    // null or transient: the 08:00 Perth job will try again.
    parts.push('retrying tomorrow');
  }
  return { text: parts.join(' · '), tone: 'unsent' };
}

export function emailState(row, which) {
  return emailStatus(row, which).text;
}

// Where the payment lives. The Stripe dashboard has no route for a Checkout
// Session id and its search does not match one either (checked live,
// 2026-09-18), but searching the organiser's email finds the customer and
// their payments — so the Stripe link is that search, until the row carries a
// payment_intent for a direct /payments/pi_… link. A PayPal reference has
// nowhere to go and is shown as text.
export function paymentLink(row) {
  const platform = row.stripe_session_id ? 'stripe' : (row.payment_platform || '');
  const reference = row.stripe_session_id || row.payment_reference || '';
  const href = platform === 'stripe' && row.customer_email
    ? `https://dashboard.stripe.com/search?query=${encodeURIComponent(row.customer_email)}`
    : null;
  return { platform, reference, href };
}

// "15 Sep 2026, 7:26 pm", in Perth.
function fmtPaid(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = Object.fromEntries(PERTH_PARTS.formatToParts(d).map(({ type, value }) => [type, value]));
  return `${p.day} ${MONTHS[Number(p.month) - 1]} ${p.year}, ${p.hour}:${p.minute} ${p.dayPeriod.toLowerCase()}`;
}

// "Mon 21 Sep 2026". event_date is a date column with no time, so it is read
// as UTC midnight — no zone can shift it to the day before.
function fmtEventDate(date) {
  if (!date) return '';
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function fmtMoney(value) {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  return Number.isNaN(n) ? '' : MONEY.format(n);
}

// Everything the table shows for one row, already formatted; each email cell
// is `{ text, tone }` with tone one of 'sent', 'unsent', 'na'. Blank strings
// rather than placeholders for fields a failed claim never wrote — the
// `problem` line says why they are blank.
export function shapeRow(row) {
  const recorded = row.status === 'fulfilled';
  let problem = '';
  if (!recorded) {
    problem = `Paid but not recorded — ${row.status === 'failed' && row.last_error ? row.last_error : 'still being recorded'}`;
  }
  return {
    id: row.id,
    paid: fmtPaid(row.created_at),
    organiser: row.customer_name || '',
    email: row.customer_email || '',
    eventDate: fmtEventDate(row.event_date),
    eventTime: row.event_time_label || '',
    amount: fmtMoney(row.amount_paid),
    fee: fmtMoney(row.fee),
    staffEmail: emailStatus(row, 'staff'),
    customerEmail: emailStatus(row, 'customer'),
    payment: paymentLink(row),
    recorded,
    problem,
  };
}
