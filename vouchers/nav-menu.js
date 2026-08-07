// The header's collapsed navigation.
//
// The hub's nav has one pinned secondary item (Reports) and a hamburger holding
// the rest. This module owns the list behind the hamburger and the question the
// trigger has to answer — "is the section I am looking at hidden in here?" — so
// that a menu item and its active state can never disagree. See vouchers#54.
//
// Two kinds of item, and the difference is visible to staff:
//   'view' — switches the hub's view in place, and carries `view`
//   'page' — leaves for another page, and carries `href`

export const SECONDARY_MENU = [
  { id: 'voucherTypes', label: 'Voucher Types', kind: 'view', view: 'voucherTypes' },
  { id: 'export', label: 'Export', kind: 'view', view: 'export' },
  { id: 'stats', label: 'Stats', kind: 'page', href: '/vouchers/stats.html' },
  { id: 'unsubscribes', label: 'Unsubscribes', kind: 'page', href: '/vouchers/unsubscribes.html' },
];

// The item the hub's current view belongs to, or null when the view is one of
// the ones still visible in the header. Matched on `view` rather than `id`, so
// the page items — which no value of `view` can ever equal — stay out of it.
export function activeMenuItem(view) {
  if (!view) return null;
  return SECONDARY_MENU.find(item => item.view === view) || null;
}
