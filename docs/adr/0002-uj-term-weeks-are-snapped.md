# ADR 0002 — UJ term weeks are snapped, not official

- **Status**: Accepted
- **Date**: 2026-08-05
- **Context**: roster calendar context ([#8](https://github.com/urbanjungleirc/staff-site/issues/8), [#10](https://github.com/urbanjungleirc/staff-site/issues/10))

> Companion: [ADR 0001](0001-hybrid-calendar-sourcing.md), on why half this
> calendar is fetched and half is hardcoded.

## Context

The roster shows staff which school term and week a date falls in, so coaches
know which session of a term block they are about to run.

The official WA term dates do not divide into whole weeks. Terms routinely start
on a Wednesday and end on a Thursday or Friday, and the Department defines the
break as starting the very next day:

```
2028  Term 1  Wednesday 2 February to Friday 7 April
      Break   Saturday 8 April to Sunday 23 April
2029  Term 1  Wednesday 31 January to Thursday 29 March
      Break   Friday 30 March to Sunday 15 April
```

UJ classes run Monday–Saturday. A term block is a run of whole weeks, and the
Saturday session at the end of a term is part of that block regardless of when
school finishes.

Taking the official dates literally would mean:

- a term starting Wednesday has a three-day "week 1", so every subsequent week
  number is a week ahead of the class block it is meant to describe;
- the Saturday session after school finishes is labelled a school break, which
  is exactly wrong for the person running it.

## Decision

Snap each official term outward to whole Monday–Sunday weeks:

- **Week 1 begins the Monday** of the week containing the official term start.
- **The final week runs through the Sunday** of the week containing the official
  term end.
- Sunday closes the week.

A school break is whatever lies between two snapped terms.

A school break advertises the next term's **snapped** start — the Monday — not
the official start. Otherwise the endpoint contradicts itself: in January 2028 it
would say "Term 1 starts Wed 2 Feb" while already classifying Mon 31 Jan as term.

## Consequences

This **deliberately deviates from education.wa.edu.au.** Under our rule, the
first Saturday after school finishes is still term. Under theirs it is a break.
Both are correct for their own purpose; ours is the one that matches the class
blocks we actually run.

**Do not "correct" the dates to match the official page.** It looks like a bug
fix and is not. It silently shifts every week number in the affected term, and
nothing about the display would look broken afterwards — which is why this ADR
exists.

The rule buys a clean invariant, since every term now ends on a Sunday and every
term starts on a Monday: **every school break is exactly 14 days, or 42 across
summer.** That is asserted across the entire term table (2025–2031) in
`cloudflare-worker/test/calendar.test.js`, and it is the check that would catch a
mistyped date in the table.

Snapping is applied to the table at module load; the official dates are kept
verbatim in `WA_SCHOOL_TERMS` so they can be re-checked against the source page.

## Alternatives considered

- **Use the official dates as published.** Rejected: produces partial weeks and
  mislabels end-of-term Saturdays, which is the whole problem.
- **Snap only the end, not the start.** Rejected: fixes the Saturday case but
  leaves a short week 1, so the week numbers still drift from the class block.
- **Store pre-snapped dates in the table.** Rejected: the table would no longer
  be comparable line-for-line against the government page, which is the only way
  to verify it.
