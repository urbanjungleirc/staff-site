# ADR 0005 — the School Pass runs 26 weeks, not a term

- **Status**: Accepted
- **Date**: 2026-08-20
- **Context**: school group booking ([#46](https://github.com/urbanjungleirc/staff-site/issues/46), [#90](https://github.com/urbanjungleirc/staff-site/issues/90)); design spec [`2026-08-19-school-group-booking-design.md`](../superpowers/specs/2026-08-19-school-group-booking-design.md) §3

> Companion: [ADR 0002](0002-uj-term-weeks-are-snapped.md), on why a UJ term
> block is a run of whole Monday–Sunday weeks rather than the official dates.

## Context

School students are created in Clubworx as **members** holding a **School Pass**,
and the pass is what makes them bookable into a School Session. The plan was
configured for **12 weeks**, sized to cover a UJ term including the edges ADR
0002 snaps outward.

That sizing carried an assumption nobody wrote down: **that the booking is made
at the start of the term it covers.** Schools do not always work that way. A
school can send its list and have staff book the whole term — ten weekly
sessions — three or four weeks before the first one.

The arithmetic is unforgiving, and it is off by only a little, which is what
makes it dangerous:

```
pass          12 weeks = 84 days of access from start_date, inclusive
term          10 weekly sessions = 63 days, first session to last
start_date    the day of the run — Clubworx sets it, and #63 measured it

lead time L → last session lands on day L + 63
safe while    L ≤ 20 days
```

**Three weeks ahead loses the last session. Four weeks ahead loses the last
two.** And nothing in the tool would notice: every booking is written on the day
of the run, when the pass is unambiguously active.

Whether an expiring pass actually costs anything is **unmeasured** — Clubworx
may check the pass only at booking time, in which case the expiry never bites, or
against the session date, in which case the tail bookings are refused, or both,
in which case a future `start_date` cannot help because the pass would not be
active when the booking is written.

## Decision

**The School Pass plan is configured for 26 weeks.**

26 weeks is 182 days of access, so a 63-day term stays covered with **up to 118
days — just under 17 weeks — of lead time**. That is past any plausible school
booking.

Two things follow, and they are the reason this is an ADR rather than a config
note:

- **The duration is not encoded anywhere in the tool.** The number 26 appears in
  no source file. The tool sends a `start_date` and *reads* `expiration_date`
  back, so the plan's configuration is the single source of truth and the change
  needed no code at all.
- **Coverage is checked, not assumed.** Before any write, the last selected
  session must fall inside the pass. For a **found** student the check is exact —
  the held pass's `expiration_date` against the last session. For a **new** one
  it is best-effort, because `GET /membership_plans` returns
  `membership_duration` as a human string (`"12 weeks"`, `"26 weeks"`); an
  unparseable duration is reported on screen, never skipped silently.

## Consequences

**This deliberately over-covers.** A student attending a ten-week term holds a
pass for six months. That is the point: the alternative fixes bought a tighter
window at the price of unproven API behaviour.

**A term's intake now reads as current members for six months**, and lapses
mid-following-term rather than at the end of the term it attended. What that does
to Clubworx member counts, retention and revenue reporting is the open question
already carried on #46 — this decision makes it larger, not smaller, and does not
resolve it.

**The `found` branch gets harder, not easier.** Under a 12-week pass a returning
student's old School Pass had usually expired, so the branch simply granted a new
one. At 26 weeks the tool will far more often find a pass that is **active today
but expires mid-term**. So `ensure School Pass` cannot mean *active today* — it
means **covers the last selected session** — and granting that pass means
granting a second one to a live holder. Whether that duplicates is the one thing
on this effort deliberately never probed, because memberships have no delete.
It is now the sharper of the two open questions; #90 is re-scoped to it.

**Do not shorten this back to a term.** It looks like an over-long default and it
is not. Twelve weeks is exactly long enough to look correct in testing — every
booking succeeds on the day it is written — and to lose the last session of a
term booked a few weeks ahead, in production, silently. The guard above is what
would catch a shortening; this ADR is what explains it.

**A School Pass costs nothing** — `upfront_payment_amount "0.0"`, no recurring
charge, no billing schedule (#60) — so the duration is free in money.

## Alternatives considered

- **Start the pass at the first selected session.** Rejected. It rests on two
  unmeasured things at once: that Clubworx honours a *future* `start_date` (#63
  flagged this as unproven — every probe so far sent today's date, which is also
  what Clubworx defaults to, so an honoured request is indistinguishable from an
  ignored one), and that the pass is checked against the session date at all. It
  also gives up the one-call create route adopted in #63, since `POST /members`
  starts the pass today, and it needs session dates the write chain does not
  receive. Two unknowns and a lost optimisation to buy what a config change buys
  outright.
- **Set the expiry explicitly, a few days after the last session.** Not
  available. `expiration_date` comes back as exactly the plan's configured
  duration; the API offers the *start*, not the end.
- **Refuse the run when the last session falls outside the pass.** Kept, but as
  a guard rather than the fix — it makes the failure visible instead of silent,
  and on its own it would simply block the far-ahead bookings this effort exists
  to make possible.
- **A second plan — a longer "School Term Pass" alongside the 12-week one.**
  Rejected: two plans mean a choice at run time, and reporting fragments across
  both. The plan name is deliberately never varied (spec §3).
