# Domain glossary — staff-site

The language this repo uses for its own concepts. When naming things in code,
issues, tests or commits, use the term as defined here rather than a synonym.

Architectural decisions live in [`docs/adr/`](docs/adr/).

## Roster calendar context

Terms describing what kind of day a roster date is. Implemented in
`cloudflare-worker/src/calendar.js` and served by `/api/calendar`.

### UJ term week

A Monday–Sunday calendar week within a school term. Week 1 begins the **Monday
of the week containing the official term start**, even when school starts
mid-week. Sunday closes the week.

Terms run 9, 10 or 11 UJ term weeks. Never assume 10 — 2026 has one of each of
the first two.

*Avoid*: "school week", "teaching week". Those imply the official WA definition,
which is not what we compute.

### Term snapping

Expanding the official WA term dates outward to whole UJ term weeks: the start
back to its Monday, the end forward to its Sunday.

UJ classes run Monday–Saturday regardless of where the official dates fall, so
the first Saturday after school finishes is still term for us. This deliberately
deviates from the official definition — see
[ADR 0002](docs/adr/0002-uj-term-weeks-are-snapped.md) before changing it.

### School break

The period between two snapped terms. Because snapping always ends a term on a
Sunday and starts the next on a Monday, a school break is **always exactly 14
days, or 42 across summer**. That invariant is asserted across the whole term
table in `cloudflare-worker/test/calendar.test.js`.

A school break advertises the date the next term starts. That is the *snapped*
Monday — the first day we ourselves call term — not the official start date.

*Avoid*: "school holidays" as a code identifier. It is the right phrase in the
UI, but "break" is the term in the data.

### Public holiday

A WA-gazetted holiday, including substitute days. Substitute days are distinct
dates, not annotations: Anzac Day 2026 legitimately occupies both Saturday 25
and Monday 27 April.

Fetched live and cached, unlike the term table beside it — see
[ADR 0001](docs/adr/0001-hybrid-calendar-sourcing.md). On the wire, a date
carries `publicHoliday: { name }` or `null`. In the UI it is a **badge in front
of** the term context, never instead of it, so the week number survives on the
days staff most want it.

*Avoid*: deduplicating by name, anywhere. Two dates sharing a name is the
substitute-day rule working correctly.

### Calendar staleness

Two distinct conditions, deliberately shown differently, and each half of the
calendar can be in either independently:

- **Broken** — the answer is missing. Amber and visible. Either the term table
  does not cover the date being viewed (`state: "unknown"`), or the holiday feed
  failed with nothing cached to fall back on (`holidaysAvailable: false`).
- **Ageing** — the answer is present but wants attention. Muted grey, because
  only the maintainer can act on it and staff should not be trained to ignore
  warnings. Either the term table is within six months of running out, or the
  holidays were served from cache after an upstream failure
  (`holidaysStale: true`).

These name the *warning tiers*, not the wire format. A day whose state the table
cannot determine is `state: "unknown"` on the wire; **broken** is the tier that
state puts the display into. The CSS classes are `is-broken` and `ctx-broken`
for that reason.

A broken holiday half never breaks the term half: the amber line sits *beneath*
a term context that still renders. Term context does not depend on the feed.

Green is reserved for the "on now" shift state and is never used for calendar
states.
