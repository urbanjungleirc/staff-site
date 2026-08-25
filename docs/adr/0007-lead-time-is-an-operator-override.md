# ADR 0007 — the lead time is an operator override, not a law

- **Status**: Accepted — built ([#143](https://github.com/urbanjungleirc/staff-site/issues/143), [#144](https://github.com/urbanjungleirc/staff-site/issues/144), [#145](https://github.com/urbanjungleirc/staff-site/issues/145), [#146](https://github.com/urbanjungleirc/staff-site/issues/146))
- **Date**: 2026-08-25
- **Context**: school group booking ([#138](https://github.com/urbanjungleirc/staff-site/issues/138)); design spec [`2026-08-19-school-group-booking-design.md`](../superpowers/specs/2026-08-19-school-group-booking-design.md) §11, D9

> Reverses the hard-stop half of D9. The other half of D9 — that the tool never
> drops a too-soon session by itself, and that staff never meet Clubworx's own
> message — stands unchanged and is load-bearing here.

> Companion: [ADR 0005](0005-school-pass-runs-26-weeks.md), the other hard-stop
> in this run's pre-write gate. Both are about a Clubworx rule the tool cannot
> see directly; 0005 changed the rule in Clubworx to fit the work, and this one
> lets an operator suspend it for a session. Neither encodes the rule in code.

## Context

A School Group Booking run refuses any selected School Session starting inside
the **lead time**, the one-day minimum between booking and a session starting.
The session-selection step raises a `block`-severity blocker and offers one
answer: remove the session. There is no way to keep it.

That was asked for, and its default is right. Clubworx enforces the minimum
server-side and refuses with *"Sorry! This class is now closed for bookings."* —
a message that names no cause and reads like a capacity problem. Meeting it
sixty times, once per student, would also trip the run halt on the third
consecutive failure and leave the run half-written.

What the design did not record is that **the restriction is lift-able**. It is a
per-class booking restriction in Clubworx, and a manager can remove it on the
specific conflicted class, run the bookings, and put it back. The tool was
modelling a gym policy that a human can suspend as though it were a property of
time.

The cost of that is not theoretical. A school sends its list on the morning of a
session often enough to matter, and today the front desk answers it by booking
sixty students by hand in Clubworx — the exact work this tool exists to remove.

**The rule is enforced twice, independently.** Session selection raises the
blocker, and the Worker's write chain re-checks the lead time per student as a
backstop before any write, refusing with its own lead-time reason and naming the
offending event ids. The two are deliberately separate: D14 keeps the Worker from
re-validating the event list, so the backstop is a guard at the point of writing
rather than a second source of truth. Any override reaching only session
selection produces a run in which every student is refused. This is the fact that
makes the change architectural rather than cosmetic, and it is why it earns an
ADR.

## Decision

**A too-soon session can be kept, per session, by an operator who states that
they have lifted its Clubworx restriction.**

Three things make that safe, and none of them is optional.

**The choice is per session, and it is a confirmation.** Each too-soon session
keeps its own blocker and its existing removal, and gains a second answer beside
it. Taking that answer raises a confirmation naming the specific session and
stating the condition plainly: the booking restriction on this class must be
lifted in Clubworx before the run starts, or every booking for it will fail.
There is no control that acknowledges them all at once — that is the silent
adjustment with a button on it that D9 rejected, wearing a different hat.

**The contract between the page and the Worker is a list of acknowledged event
ids, never a flag.** The page sends the exact ids the operator acknowledged, and
the Worker narrows its refusal to too-soon sessions that are *not* on that list.
Everything unacknowledged is still refused, with the same reason and the same
naming of ids as today.

**The run reminds staff to put the restriction back**, naming every session whose
restriction was lifted, and that reminder is written into the JSON run record as
well as onto the result screen.

An acknowledged session's refusal drops from `block` to `warn`. It is **not**
removed from the blocker list: a session that disappears once acknowledged is
invisible and unexplained, which is the shape D9 exists to prevent.

**Only the lead-time refusal is overridable.** An unreadable start time means the
rule could not be checked at all, so "we cannot check this" must never become
"you may override this". An already-started session is not a restriction the gym
can lift. Both stay hard-stops.

**The minimum itself does not move.** It stays defined once, with the events, and
re-exported to the write chain. This decision narrows *who the rule is applied
to*; it never re-derives what the rule is, and it does not make the number
configurable.

**The tool never changes a Clubworx restriction itself.** It does not lift one
before the run and does not restore one after it. It states the condition and
reminds; a person acts.

## Consequences

**The silent damage moves.** Before this, the worst case was a refused run —
loud, immediate, self-correcting. After it, the worst case is **a restriction
left lifted after the run**: a class open to public booking for as long as nobody
notices. That is the risk this whole decision is shaped around, and it is why the
reminder is sourced from the *selection* rather than from the run's results. A
run that halts on its third consecutive failure produces no results for the
acknowledged session at all, which is precisely when a restriction is most likely
to have been left open; a reminder derived from results would go missing exactly
when it matters most.

**The backstop stays live for everything nobody acknowledged.** Naming ids rather
than setting a flag is what buys this, and the case is real: a sixty-student list
started at 23:40 can have a session cross into the lead time between selection
and the write. Under a flag that session books silently. Under ids it is still
refused, because nobody took responsibility for it.

**An override taken without actually lifting the restriction fails loudly.** The
bookings come back as ordinary refusals and the third consecutive one halts the
run. That is an acceptable failure mode — it is visible, it stops early, and
nothing permanent is written for the refused rows. It does mean the confirmation
copy naming the consequence matters more than the mechanics do.

**The Worker gains an input, not an opinion.** D14 still holds: the write chain
does not re-validate the event list, and its lead-time gate remains a guard at
the point of writing. It now knows which sessions a human vouched for. It still
decides nothing about them.

**Session selection and the write chain must not be able to disagree.** They
already share one definition of the rule; they now also share one list of
exceptions. The sequencing follows from that — the Worker's gate is narrowed
**before** the page can offer an override, so there is never a build in which a
screen promises something the write chain would refuse.

**§11's hard-stop table is now wrong about one of its rows**, and the domain
vocabulary's *Lead time* entry with it. Both are amended alongside this ADR. Left
stale, the next reader treats the override as a bug and removes it — which is the
specific failure this document exists to prevent.

**Nothing here changes the run halt.** Three consecutive failures still stop a
run.

## Alternatives considered

- **A single "allow too-soon" flag on the run.** Rejected. It switches the
  Worker's backstop off wholesale rather than narrowing it, so it also covers
  sessions the operator never saw and sessions that crossed into the lead time
  after selection. It is simpler by exactly the amount of safety it removes, and
  the tell is that no test can distinguish "narrowed" from "switched off" under
  it.
- **Lift the restriction in Clubworx automatically, and restore it after.** Not
  adopted, and not merely unbuilt: it removes the human judgement the
  confirmation exists to capture, and it would leave the tool holding a
  gym-policy control it has no way to restore reliably if the run dies mid-flight
  or the tab closes. No API surface for it is assumed here either way.
- **Drop the too-soon session automatically and run the rest.** Already rejected
  as D9 and still rejected. A silent adjustment is worse than a refusal, and it
  is worse again now that keeping the session is a real option.
- **One override for the whole run.** Rejected for the same reason as the flag,
  one layer up: acknowledging a Tuesday session should not acknowledge a Thursday
  one the operator never looked at.
- **Source the restore reminder from the run's results.** Rejected — see the
  first consequence. The results are empty in the case that most needs the
  reminder.
- **Shorten or make the minimum configurable.** Out of scope and undesirable. The
  number is Clubworx's, it is right, and a per-run knob would turn a deliberate
  exception into a default nobody reads.
