# ADR 0006 — voucher scanning is a global keyboard wedge, not a camera

- **Status**: Accepted — designed 2026-08-25, hardware verified 2026-08-25, not yet implemented
- **Date**: 2026-08-25
- **Hardware**: Zebra DS2208, corded USB, at the front desk
- **Companion**: vouchers [ADR 0004](https://github.com/urbanjungleirc/vouchers/blob/main/docs/adr/0004-human-readable-voucher-codes.md) — the code format this depends on

## Context

The hub already contained a scanning surface: a `view === 'scan'` screen driving
the device camera through `html5-qrcode`, loaded from unpkg, with a manual
`UJ-XXXX-XXXX` box beside it. **It was unreachable.** `goScan()` had no caller
anywhere in the repo — no nav entry, no button. So the camera scanner was never
a working alternative that we chose against; it was dead code that happened to
describe an approach.

The counter needs the opposite of a camera: a customer holds up a phone, and a
staff member wants the voucher on screen and the redeem form open, without
touching anything. A corded imager does that; a webcam pointed across a desk
does not.

A DS2208 in its default mode is a **USB HID keyboard**. It does not present an
API — it types. That single fact drives everything below: the design problem is
not "how do we read the scanner", it is "what do we do with keystrokes that
arrive from nowhere".

## Decision

**Scanning is a document-level keystroke listener on the voucher hub, gated on
the shape of the voucher code.** The camera view, its manual box and the unpkg
script are deleted.

Four rules make it up.

**1. The scanner's contract is "characters, then Enter" — nothing more.** The
scanner is programmed with the Enter suffix and otherwise left at defaults. The
app trims and uppercases whatever arrives before testing it, so a till with Caps
Lock on, or a replacement unit programmed by someone else, still works. Nothing
in the app depends on the scanner's symbology settings, prefix, or inter-character
timing.

**2. A buffer is a scan when it is Enter-terminated and matches `UJ-XXXX-XXXX`.**
Not a timing heuristic, not a magic prefix character. Shape is enough because
the listener is suppressed whenever focus is in a text box: to false-positive, a
person would have to type a well-formed voucher code with nothing focused.

**3. Scanning is off entirely while any modal is open.** A modal is a committed
task. The type editor guards unsaved changes behind a discard prompt, and a scan
that jumped past it would reintroduce exactly the loss that guard exists to
prevent. Close the modal, then scan.

**4. A voucher code goes to the redeem form however it arrived.** A scan and a
valid code typed into the search box that matches exactly one voucher reach the
same destination. Physical voucher cards carry no QR — only a printed code — so
typing is the counter path for a whole class of vouchers, and giving it a
different destination would mean two rules for the same thing.

The destination itself:

| Voucher state | Where the scan lands |
|---|---|
| `active` (including partially redeemed) | Detail view, redeem modal open, **amount blank, focus in amount** |
| expired | Detail view, amber banner |
| cancelled | Detail view, rose banner |
| no balance left | Detail view, sky banner |
| well-formed, no such voucher | Stays put, "No voucher UJ-XXXX-XXXX" |
| not a voucher code | Stays put, "That isn't a voucher code" |

## What the scanner actually sends — measured

Measured 2026-08-25 on the front-desk unit with a throwaway echo page, scanning a
real voucher QR (`UJ-TQYH-F8PW`) off a phone screen, with the Enter suffix
already programmed through the Zebra 123Scan settings.

**A 12-character code arrives as 22 keydown events.** Every letter is preceded
by its own discrete `ShiftLeft` keydown (`keyCode` 16); digits and hyphens are
not. The scanner types uppercase the way a person does, rather than emitting
pre-shifted characters.

> **This is the trap.** A listener that appends `e.key` on every keydown builds
> `ShiftUShiftJ-ShiftT…`. The buffer must accept **only single-character `e.key`
> values** and drop everything else. Beyond that filter no shift bookkeeping is
> needed — `e.key` is already `"U"`, not `"u"`.

The rest, for the record:

| | |
|---|---|
| Terminator | `Enter`, `keyCode` 13 — one, at the end |
| Prefix | none |
| Modifiers | `Shift` only, and only on letters |
| Hyphen | `e.code` `Minus`, `keyCode` 189 — survives the Australian Windows layout intact |
| Between characters | 0–5 ms (avg 2 ms) |
| Whole burst | 40 ms |

The timings say a burst heuristic *would* have worked — worth knowing if the
shape test ever has to widen — but they are recorded as evidence, not relied on.
Nothing in the app reads a clock.

**Not tested: a printed email.** The glossy, backlit case passed, and imagers
generally read matte paper more easily, so this was judged not worth blocking on.

## Consequences

**The redeem modal has to identify the voucher itself.** Until now it could
assume staff had read the detail page on the way in — it showed a title and a
balance and nothing else. A scan skips that reading, so the modal gains code,
customer name, type and item alongside the balance. Without it, the realistic
counter error — the right-looking voucher belonging to the wrong person —
has nothing to catch it.

**The amount is deliberately not pre-filled.** Pre-filling the full balance
would be fewer keystrokes for the common case and would make a partial redeem
the path you have to *notice*. A redeem is irreversible without a manager, so
the amount stays a deliberate act.

**The code format is now stated in two repos.** `scan-input.js` in staff-site
carries a regex describing what vouchers' `voucher-codes.js` generates. That is
a knowing duplication, not an oversight: asking the Worker to decide whether a
keystroke burst is a voucher code would put a network round-trip in front of
every stray scan. The regex is commented with a pointer to vouchers ADR 0004,
which is where the format is actually decided. **If the format ever changes, this
is the second place.**

**Legacy UUID vouchers are not scannable, and that is fine.** Vouchers migrated
from the GAS system kept their UUID codes, and those emails never carried a QR —
there is nothing to point a scanner at. Widening the shape test to match UUIDs
would loosen it for no reachable benefit. They stay a search-box job.

**Physical cards stay a typing job.** The cards handed over in the shop carry a
printed code and no QR, so the scanner cannot help with them at all. Printing a
QR on the card is out of scope here, not deferred — but rule 4 is what stops
that limitation from also costing them the fast path.

**Nothing scans outside the hub.** `stats.html` and `unsubscribes.html` have no
listener. They have no voucher to redeem.

**A scan into the search box still works, by a different road.** Suppression
means the listener ignores it, but the characters land in the field and the
Enter submits the form — where rule 4 recognises the code and sends it to the
same place. So the common counter accident, scanning while the search box still
has focus from the last lookup, behaves identically. That is a consequence of
the two rules meeting, not a third rule, and the setup runbook says so because
it otherwise looks like luck.

## Alternatives considered

- **Keep the camera view and unify the two paths.** Rejected once it turned out
  the view was unreachable: there is no phone or tablet workflow in production
  to preserve, so "keeping it" meant reviving dead code and carrying a
  third-party script from unpkg on a page behind Access.
- **A distinctive prefix character programmed into the scanner.** Unambiguous,
  and it would work for any code shape including UUIDs. Rejected because it
  makes the scanner's configuration load-bearing — a factory reset leaves the
  hub silently deaf until someone finds the programming sheet. Shape-testing
  fails soft; a missing prefix fails silent.
- **Burst timing (characters arriving faster than a human types).** Rejected as
  fiddly to test and capable of misfiring on a loaded machine, for a robustness
  gain the shape test already provides.
- **Park focus in a hidden input so scans always land somewhere.** Rejected: any
  click elsewhere breaks scanning until focus returns, and nothing on screen
  would say so.
- **Send every Enter-terminated buffer to the Worker and let it decide.** One
  definition of the code format instead of two — but a round-trip per stray
  scan, and a slower, less certain "that isn't a voucher code".
- **Scan straight through an open modal.** Rejected under rule 3. A second
  voucher handed over mid-transaction is real but rare, and the cost of getting
  it wrong is a discarded redeem or an unsaved type edit.
