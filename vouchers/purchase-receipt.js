// vouchers/purchase-receipt.js
// Whether the staff create form must collect a Clubworx receipt number.
// Pure on purpose, so the rule is unit-testable and the label, the validation
// and the placeholder cannot drift apart.
//
// Mirrors the Worker's receiptRequired() (vouchers repo, #118): a receipt is
// demanded for real sales only. Comps, credits and donations have no Clubworx
// sale behind them, so the field stays optional there. The Worker is the
// authority — this only saves staff a round trip.
export function receiptRequired(voucherType) {
  return voucherType?.revenue_class === 'sale' || voucherType?.revenue_class === 'promo_sale';
}
