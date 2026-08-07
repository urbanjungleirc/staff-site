// vouchers/version-display.js
// Formats the build version for the hub footer. Pure on purpose — no DOM, no
// fetch — so the two things that are genuinely easy to get wrong, the Perth
// timestamp and the decision to show nothing, are unit-testable.
//
// The version is on the page so a stale cached copy can be spotted, which makes
// a wrong version worse than none: it reports a stale build as current with the
// authority of being printed. Anything not fully trusted renders as '', and the
// footer falls back to showing the signed-in email alone.
//
// See docs/adr/0004-voucher-hub-build-version.md for where the payload comes
// from, and why it is absent on a plain checkout.

// Two traps here, both deliberate rather than incidental:
//  - en-AU renders month:"short" as "July", not "Jul". en-GB gives "Jul".
//  - hour12:false is specified to permit a broken h24 cycle that renders
//    midnight as "24:00"; hourCycle:"h23" is the knob that does not.
// Assembled from formatToParts rather than by string-munging the formatted
// output, because separator and field order are ICU details that differ between
// browsers — and this formats client-side, on whatever ICU is there.
const TIME_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Australia/Perth',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function perthTime(builtAt) {
  if (typeof builtAt !== 'string' || !builtAt) return '';
  const d = new Date(builtAt);
  if (Number.isNaN(d.getTime())) return '';
  const p = {};
  for (const part of TIME_FMT.formatToParts(d)) p[part.type] = part.value;
  return `${p.day} ${p.month} ${p.hour}:${p.minute}`;
}

export function formatBuildVersion(payload) {
  const { version, sha, builtAt } = payload || {};

  // The generator emits a bare commit count, or "dev" when git could not be
  // trusted. Anything else means we are reading something other than what we
  // think we are, so none of it gets shown.
  if (typeof version !== 'string' || !/^\d+$/.test(version)) return '';

  return [
    `v${version}`,
    /^[0-9a-f]{7}$/.test(sha) ? sha : '',
    perthTime(builtAt),
  ].filter(Boolean).join(' · ');
}
