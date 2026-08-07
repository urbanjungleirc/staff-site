// Pure rules behind the hard-delete action on vouchers/index.html.
//
// Extracted so the things standing between a mis-click and an unrecoverable
// delete are testable without a browser. The page imports this and publishes it
// as `window.deleteLogic`, the same seam image-pipeline.js and
// unsubscribes-logic.js use. Nothing here touches the DOM, Alpine, or the network.
//
// Hard delete has no eligibility rule on the server — any voucher, any status,
// including paid and redeemed ones (that is deliberate; test vouchers arrive from
// too many sources for a "safe to delete" predicate to be reliable). Its
// protection is the Access-email allowlist plus the typed-code confirmation
// below. See docs/superpowers/specs/2026-08-05-voucher-hard-delete-design.md in
// the vouchers hub repo.

const norm = (value) => String(value ?? '').trim().toUpperCase();

// The typed confirmation is what the allowlist cannot provide: the allowlist
// authenticates the session, not the person currently at the keyboard, so an
// unlocked laptop is still an allowed identity.
export function codeConfirmed(typed, voucherCode) {
  const target = norm(voucherCode);
  if (!target) return false; // no voucher ⇒ nothing can confirm, empty box included
  return norm(typed) === target;
}

export function canSubmitDelete({ voucher, typedCode, reason, busy } = {}) {
  if (busy) return false;
  if (!voucher) return false;
  if (!String(reason ?? '').trim()) return false;
  return codeConfirmed(typedCode, voucher.voucher_id);
}

// Signals that this is a real transaction rather than a test artefact. Shown
// louder than the rest of the modal, because these are the deletes that cost
// something — a redeemed voucher's history and a customer's payment both vanish
// from the live table (the audit snapshot survives, but only for manual recovery).
export function deleteWarnings(voucher) {
  if (!voucher) return [];
  const warnings = [];

  // Balance drift is the more reliable signal: rows migrated from v2 carry the
  // reduced balance without the per-redemption columns.
  const spent = Number(voucher.balance) < Number(voucher.value);
  if (voucher.last_redeemed_amount || spent) {
    warnings.push('This voucher has been redeemed — that history is deleted with it.');
  }

  if (String(voucher.payment_reference ?? '').trim()) {
    const platform = String(voucher.payment_platform ?? '').trim();
    warnings.push(
      `This voucher was paid for${platform ? ` via ${platform}` : ''} — deleting it does not refund anything.`,
    );
  }

  return warnings;
}

// 401 and 403 mean different things here and must not be collapsed. 401 is the
// staff gate — the Access session lapsed, and reloading fixes it. 403 is the
// delete allowlist — the session is perfectly valid and reloading will never
// help, because the answer is about who you are.
export function deleteErrorMessage(err) {
  if (err?.status === 403) {
    return 'Only an authorised account can delete vouchers. Your sign-in is valid, but this address is not on the delete allowlist.';
  }
  return err?.message || 'Could not delete this voucher. Please try again.';
}

// The deleted row is gone server-side, so leaving it in the result set offers a
// detail view that 404s. Returns a new array — Alpine re-renders on assignment.
export function withoutVoucher(results, code) {
  if (!Array.isArray(results)) return [];
  const target = norm(code);
  return results.filter((row) => norm(row?.voucher_id) !== target);
}
