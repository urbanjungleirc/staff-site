import { describe, expect, test } from 'vitest';
import {
  perthToday,
  groupDeposits,
  emailState,
  paymentLink,
  shapeRow,
} from '../logic.js';

// The page (deposits.html) is a read-only list, so the only decisions it makes
// are which group a deposit lands in, what order the groups are in, what each
// email-state cell says, and where the payment link goes. Those are pinned
// here; the HTML is not unit-tested (staff-site#154, spec vouchers#100).

// Fixtures mirror the Worker's own (payments-worker/test/deposit-list.test.js)
// so a shape change there shows up here as a failing test, not a blank page.
const WEBHOOK_ROW = {
  id: 'a1',
  stripe_session_id: 'cs_live_byford',
  payment_platform: 'stripe',
  payment_reference: null,
  status: 'fulfilled',
  source: 'webhook',
  customer_name: 'Byford Scout Group',
  customer_email: 'leader@example.com',
  event_date: '2026-09-21',
  event_time_label: '10.30am',
  amount_paid: 100,
  fee: 2.3,
  created_at: '2026-09-15T11:26:00+00:00',
  fulfilled_at: '2026-09-15T11:26:01+00:00',
  last_error: null,
  staff_email_sent_at: '2026-09-15T11:26:02+00:00',
  customer_email_sent_at: '2026-09-15T11:26:03+00:00',
  customer_email_attempts: 0,
  staff_email_attempts: 0,
  customer_email_send_state: null,
  staff_email_send_state: null,
  undeliverable_notice_sent_at: null,
};

const IMPORTED_ROW = {
  ...WEBHOOK_ROW,
  id: 'b2',
  stripe_session_id: null,
  payment_platform: 'paypal',
  payment_reference: '8XY12345AB678901C',
  source: 'import',
  customer_name: 'Armadale Scouts',
  customer_email: 'scouts@example.com',
  event_date: '2025-11-02',
  event_time_label: '2pm',
  fee: 0,
  created_at: '2025-10-20T02:00:00+00:00',
  fulfilled_at: '2025-10-20T02:00:00+00:00',
  staff_email_sent_at: null,
  customer_email_sent_at: null,
};

// The interim claim (vouchers#101): inserted by the webhook, fulfilment threw.
// Everything the customer typed is missing, and it is still a paid deposit.
const FAILED_CLAIM_ROW = {
  ...WEBHOOK_ROW,
  id: 'c3',
  stripe_session_id: 'cs_live_stalled',
  status: 'failed',
  customer_name: null,
  customer_email: null,
  event_date: null,
  event_time_label: null,
  amount_paid: null,
  fee: null,
  created_at: '2026-09-16T03:00:00+00:00',
  fulfilled_at: null,
  last_error: 'Supabase PATCH failed (500): upstream timeout',
  staff_email_sent_at: null,
  customer_email_sent_at: null,
};

describe('perthToday', () => {
  test('is the calendar date in Perth, not UTC', () => {
    // 17:30 UTC on the 18th is 01:30 on the 19th in Perth (UTC+8, no DST).
    expect(perthToday(new Date('2026-09-18T17:30:00Z'))).toBe('2026-09-19');
    // And 15:59 UTC is still the 18th there.
    expect(perthToday(new Date('2026-09-18T15:59:00Z'))).toBe('2026-09-18');
  });
});

describe('groupDeposits', () => {
  const today = '2026-09-18';

  test('puts an event today or later in upcoming, and earlier in past', () => {
    const { upcoming, past } = groupDeposits([
      { ...WEBHOOK_ROW, id: 'later', event_date: '2026-09-21' },
      { ...WEBHOOK_ROW, id: 'today', event_date: '2026-09-18' },
      { ...WEBHOOK_ROW, id: 'yesterday', event_date: '2026-09-17' },
    ], today);

    expect(upcoming.map((r) => r.id).sort()).toEqual(['later', 'today']);
    expect(past.map((r) => r.id)).toEqual(['yesterday']);
  });

  test('orders each group newest paid first, whatever order the rows arrive in', () => {
    const { upcoming, past } = groupDeposits([
      { ...WEBHOOK_ROW, id: 'u-old', event_date: '2026-10-01', created_at: '2026-09-01T00:00:00Z' },
      { ...WEBHOOK_ROW, id: 'p-old', event_date: '2026-01-01', created_at: '2025-12-01T00:00:00Z' },
      { ...WEBHOOK_ROW, id: 'u-new', event_date: '2026-09-25', created_at: '2026-09-10T00:00:00Z' },
      { ...WEBHOOK_ROW, id: 'p-new', event_date: '2026-02-01', created_at: '2026-01-15T00:00:00Z' },
    ], today);

    // Paid date, not event date: u-old's event is later but it was paid first.
    expect(upcoming.map((r) => r.id)).toEqual(['u-new', 'u-old']);
    expect(past.map((r) => r.id)).toEqual(['p-new', 'p-old']);
  });

  test('a deposit paid but never recorded (no event date) sits at the top of upcoming', () => {
    // A failed claim has no event date to compare. Filing it under past would
    // bury the one row on the page that needs someone to act on it.
    const { upcoming, past } = groupDeposits([
      { ...WEBHOOK_ROW, id: 'ok', event_date: '2026-09-30', created_at: '2026-09-17T00:00:00Z' },
      FAILED_CLAIM_ROW,
    ], today);

    expect(upcoming.map((r) => r.id)).toEqual(['c3', 'ok']);
    expect(past).toEqual([]);
  });

  test('does not mutate the input', () => {
    const rows = [IMPORTED_ROW, WEBHOOK_ROW];
    groupDeposits(rows, today);
    expect(rows.map((r) => r.id)).toEqual(['b2', 'a1']);
  });

  test('handles an empty list', () => {
    expect(groupDeposits([], today)).toEqual({ upcoming: [], past: [] });
  });
});

describe('emailState', () => {
  test('a sent email reads as sent', () => {
    expect(emailState(WEBHOOK_ROW, 'staff')).toBe('Sent');
    expect(emailState(WEBHOOK_ROW, 'customer')).toBe('Sent');
  });

  test('an imported row is not applicable, not failed', () => {
    // Null timestamps on an imported row mean the Sheet never recorded them —
    // the emails went out from Apps Script at the time. Reading that as "not
    // sent" would flag every historical deposit.
    expect(emailState(IMPORTED_ROW, 'staff')).toBe('Not applicable — imported from the Sheet');
    expect(emailState(IMPORTED_ROW, 'customer')).toBe('Not applicable — imported from the Sheet');
  });

  test('a permanently failed email says why', () => {
    const row = {
      ...WEBHOOK_ROW,
      customer_email_sent_at: null,
      customer_email_attempts: 1,
      customer_email_send_state: 'permanent',
      last_error: 'Resend rejected the address',
    };
    expect(emailState(row, 'customer')).toBe('Not sent — Resend rejected the address');
    // The staff copy on the same row went out.
    expect(emailState(row, 'staff')).toBe('Sent');
  });

  test('a transiently failed email says it will be retried', () => {
    const row = {
      ...WEBHOOK_ROW,
      staff_email_sent_at: null,
      staff_email_attempts: 1,
      staff_email_send_state: 'transient',
      last_error: 'Resend 503',
    };
    expect(emailState(row, 'staff')).toBe('Not sent — Resend 503 · retrying tomorrow');
  });

  test('an unsent email the daily job has not yet touched is still retrying', () => {
    // The webhook's own send failed; the 08:00 job has not run since.
    const row = { ...WEBHOOK_ROW, customer_email_sent_at: null, last_error: 'Resend 500' };
    expect(emailState(row, 'customer')).toBe('Not sent — Resend 500 · retrying tomorrow');
  });

  test('a failed email with no recorded reason still says it was not sent', () => {
    const row = { ...WEBHOOK_ROW, customer_email_sent_at: null, last_error: null };
    expect(emailState(row, 'customer')).toBe('Not sent — no reason recorded · retrying tomorrow');
  });

  test('a customer email frontdesk was told about says so', () => {
    const row = {
      ...WEBHOOK_ROW,
      customer_email_sent_at: null,
      customer_email_send_state: 'permanent',
      last_error: 'Resend rejected the address',
      undeliverable_notice_sent_at: '2026-09-18T00:00:00Z',
    };
    expect(emailState(row, 'customer')).toBe('Not sent — Resend rejected the address · frontdesk notified');
  });

  test('a deposit that was never recorded has no email to report on', () => {
    expect(emailState(FAILED_CLAIM_ROW, 'staff')).toBe('Not sent — deposit not recorded');
    expect(emailState({ ...FAILED_CLAIM_ROW, status: 'pending' }, 'customer')).toBe('Not sent — deposit not recorded');
  });
});

describe('paymentLink', () => {
  test('a Stripe session id links to that payment in the Stripe dashboard', () => {
    expect(paymentLink(WEBHOOK_ROW)).toEqual({
      label: 'cs_live_byford',
      href: 'https://dashboard.stripe.com/search?query=cs_live_byford',
    });
  });

  test('an imported PayPal reference is shown but not linked', () => {
    expect(paymentLink(IMPORTED_ROW)).toEqual({ label: '8XY12345AB678901C', href: null });
  });

  test('an imported Stripe row with a session id still links', () => {
    const row = { ...IMPORTED_ROW, payment_platform: 'stripe', stripe_session_id: 'cs_live_old', payment_reference: null };
    expect(paymentLink(row).href).toBe('https://dashboard.stripe.com/search?query=cs_live_old');
  });

  test('a row with neither renders an empty label', () => {
    expect(paymentLink({ ...IMPORTED_ROW, payment_reference: null })).toEqual({ label: '', href: null });
  });
});

describe('shapeRow', () => {
  test('shapes a recorded webhook row for the table', () => {
    expect(shapeRow(WEBHOOK_ROW)).toEqual({
      id: 'a1',
      paid: '15 Sep 2026, 7:26 pm',
      organiser: 'Byford Scout Group',
      email: 'leader@example.com',
      event: 'Mon 21 Sep 2026, 10.30am',
      amount: '$100.00',
      fee: '$2.30',
      staffEmail: 'Sent',
      customerEmail: 'Sent',
      payment: { label: 'cs_live_byford', href: 'https://dashboard.stripe.com/search?query=cs_live_byford' },
      recorded: true,
      problem: '',
    });
  });

  test('formats paid time in Perth, not UTC', () => {
    // 23:30 UTC on the 15th is 07:30 on the 16th in Perth.
    expect(shapeRow({ ...WEBHOOK_ROW, created_at: '2026-09-15T23:30:00Z' }).paid).toBe('16 Sep 2026, 7:30 am');
  });

  test('an event with no time label shows the date alone', () => {
    expect(shapeRow({ ...WEBHOOK_ROW, event_time_label: null }).event).toBe('Mon 21 Sep 2026');
  });

  test('an imported row keeps its zero fee and PayPal reference', () => {
    const shaped = shapeRow(IMPORTED_ROW);
    expect(shaped.fee).toBe('$0.00');
    expect(shaped.payment).toEqual({ label: '8XY12345AB678901C', href: null });
    expect(shaped.staffEmail).toBe('Not applicable — imported from the Sheet');
  });

  test('a paid-but-unrecorded deposit is marked and carries the reason', () => {
    const shaped = shapeRow(FAILED_CLAIM_ROW);
    expect(shaped.recorded).toBe(false);
    expect(shaped.problem).toBe('Paid but not recorded — Supabase PATCH failed (500): upstream timeout');
    // Nothing invented for the fields that were never written.
    expect(shaped.organiser).toBe('');
    expect(shaped.event).toBe('');
    expect(shaped.amount).toBe('');
    expect(shaped.fee).toBe('');
  });

  test('a pending claim is unrecorded without a reason yet', () => {
    const shaped = shapeRow({ ...FAILED_CLAIM_ROW, status: 'pending', last_error: null });
    expect(shaped.recorded).toBe(false);
    expect(shaped.problem).toBe('Paid but not recorded — still being recorded');
  });
});
