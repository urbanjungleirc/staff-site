import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';

// Email delivery on the two staff pages: the dashboard's "not sent" line and
// filter in index.html, and the Resend delivery tiles in stats.html. Both are
// Alpine markup inline in the pages, where no unit test can call them, so the
// wiring is pinned against the page source — the same way nav-menu.test.js and
// stats-chart-lifecycle.test.js do it.
//
// The Worker side (status=unsent, unsent_count, /v1/vouchers/email-metrics,
// the Resend webhook) is tested in the vouchers repo; see ADR 0010 there.

const hub = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const stats = readFileSync(new URL('../stats.html', import.meta.url), 'utf8');

function slice(page, startAnchor, endAnchor) {
  const start = page.indexOf(startAnchor);
  if (start < 0) throw new Error('could not find ' + startAnchor);
  const end = page.indexOf(endAnchor, start);
  return page.slice(start, end < 0 ? undefined : end);
}

describe('the hub surfaces vouchers whose email did not get through', () => {
  test('"Not sent" is a status in the search filter, sent as status=unsent', () => {
    const options = slice(hub, 'statusOptions: [', '],');
    expect(options).toMatch(/\{ value: 'unsent', label: 'Not sent' \}/);
  });

  test('the Outstanding card shows the count and opens that filter', () => {
    const card = slice(hub, '<!-- Outstanding: what', '<!-- Today: what happened');
    expect(card).toMatch(/dashStats\?\.unsent_count/);
    expect(card).toMatch(/@click="showUnsentVouchers\(\)"/);
    // The line reads red only when there is something to do.
    expect(card).toMatch(/unsent_count \?\? 0\) > 0 \? 'text-rose-700'/);
  });

  test('showUnsentVouchers is the active-vouchers drill-down with the unsent status', () => {
    const fn = slice(hub, 'async showUnsentVouchers() {', '},');
    expect(fn).toMatch(/this\.q = ''/);
    expect(fn).toMatch(/this\.statusFilter = 'unsent'/);
    expect(fn).toMatch(/await this\.search\(\)/);
  });
});

describe('the stats page shows Resend delivery totals', () => {
  test('fetches /v1/vouchers/email-metrics once, from init, never from the filter row', () => {
    expect(stats).toMatch(/this\.api\('\/v1\/vouchers\/email-metrics'\)/);
    // One call site: init(). apply() → load() must not refetch a window the
    // filters do not scope, or the tiles would look filtered.
    expect([...stats.matchAll(/this\.loadEmailMetrics\(\)/g)].length).toBe(1);
    const init = slice(stats, 'async init() {', 'async loadEmailMetrics() {');
    expect(init).toMatch(/this\.loadEmailMetrics\(\)/);
    const load = slice(stats, 'async load() {', '\n      },');
    expect(load).not.toMatch(/loadEmailMetrics/);
  });

  test('a failed fetch shows a message rather than zeros', () => {
    const fn = slice(stats, 'async loadEmailMetrics() {', '\n      },');
    expect(fn).toMatch(/this\.emailMetrics = null/);
    expect(fn).toMatch(/this\.emailMetricsError = e\.message/);
    expect(stats).toMatch(/x-show="emailMetricsError"/);
  });

  test('the tiles render the rate and the permanent/temporary split, and say the filters do not apply', () => {
    const section = slice(stats, '<!-- 5b ── Email delivery', '<!-- 6 ── Item mix -->');
    expect(section).toMatch(/pctOrDash\(emailMetrics\?\.delivery_rate\)/);
    expect(section).toMatch(/bounced_permanent/);
    expect(section).toMatch(/bounced_transient/);
    expect(section).toMatch(/emailMetrics\.complained \+ emailMetrics\.suppressed/);
    expect(section).toMatch(/the filters above do not apply/);
  });
});
