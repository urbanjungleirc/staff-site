// Pure derivations behind vouchers/unsubscribes.html.
//
// Extracted so the rules that decide what staff see — and what they are allowed
// to act on — are testable without a browser. The page imports this and
// publishes it as `window.unsubscribeLogic`, the same seam image-pipeline.js
// uses. Nothing here touches the DOM, Alpine, or the network.
//
// The page's subject is the UNION of two suppression sources (voucher_optouts
// and Clubworx's own flag) and only the first is ours to edit; see
// docs/superpowers/specs/2026-08-04-voucher-email-unsubscribe-admin.md in the
// vouchers hub repo.

// Sources this system recorded, and can therefore delete.
const OURS = ['email_link', 'staff'];

const SOURCE_LABELS = {
  email_link: 'Via unsubscribe link',
  staff: 'Added by staff',
  clubworx: 'Unsubscribed in Clubworx',
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const norm = (value) => String(value || '').trim().toLowerCase();

// A row missing the flag is treated as a former member: showing a stale opt-out
// among current members reads as an active member being suppressed, which is
// the more misleading of the two errors.
export function partitionSuppressions(suppressions = []) {
  return {
    current: suppressions.filter((s) => s.in_current_list === true),
    former: suppressions.filter((s) => s.in_current_list !== true),
  };
}

// Only what this system recorded can be undone here. A Clubworx-only row has
// nothing for us to delete, and a Resubscribe button on it would promise an
// action that cannot happen.
export function isRemovable(row) {
  return (row?.sources || []).some((s) => OURS.includes(s));
}

// The database says "opt-out"; the member-facing email says "unsubscribe". The
// UI speaks the member's word. An unknown source renders as itself rather than
// disappearing.
export function sourceLabel(source) {
  return SOURCE_LABELS[source] || source;
}

export function matchMembers(members = [], query, suppressedEmails = new Set()) {
  const q = norm(query);
  if (!q) return [];

  return members
    .filter((m) => norm(m.email).includes(q) || (m.names || []).some((n) => norm(n).includes(q)))
    .slice(0, 25)
    .map((m) => ({ ...m, alreadySuppressed: suppressedEmails.has(m.email) }));
}

// Offered only when the text is plausibly an address AND no member already
// holds it, so the free-text escape hatch never shadows the picker.
export function isFreeTextOffer(members = [], query) {
  const q = norm(query);
  if (!EMAIL_RE.test(q)) return false;
  return !members.some((m) => norm(m.email) === q);
}
