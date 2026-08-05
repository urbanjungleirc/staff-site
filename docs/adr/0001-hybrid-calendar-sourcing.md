# ADR 0001 — Hybrid calendar sourcing: holidays fetched, terms hardcoded

- **Status**: Accepted
- **Date**: 2026-08-05
- **Context**: roster calendar context ([#8](https://github.com/urbanjungleirc/staff-site/issues/8), [#11](https://github.com/urbanjungleirc/staff-site/issues/11))

## Context

The roster context line needs two datasets: WA public holidays, and WA public
school term dates. They look like the same kind of problem — a published
government calendar — and the obvious instinct is to source both the same way.

They cannot be. What exists for each is different:

- **Public holidays** are available from a live feed covering 2024 through 2035
  and beyond, including substitute days.
- **School terms** have no machine-readable source anywhere. Confirmed absent
  from both `data.wa.gov.au` and `data.gov.au`. The only official publication is
  an HTML page built out of JS accordions. The holiday feed does carry
  school-holiday blocks, but they stop at 2026-12-18 — about five months out.

Public holidays also carry substitute-day rules that change with the calendar
each year (Anzac Day 2026 falls on a Saturday, so the Monday is gazetted too).
Term dates, by contrast, are four fixed rows per year that change never.

## Decision

Source the two halves differently, matching how each is actually published.

**Public holidays: fetched live**, from the Enrico ICS feed, through this Worker:

```
https://www.kayaposoft.com/enrico/ics/v2.0/?country=aus&region=wa&fromDate=…&toDate=…&lang=en&holidayType=public_holiday
```

The Worker is a *required* intermediary, not a convenience: the feed serves no
CORS headers, so the browser cannot call it at all.

**School terms: hardcoded** in `cloudflare-worker/src/calendar.js`, through 2031,
with the source URL and a last-verified date in the comment. Years from 2029 are
marked preliminary because the government page marks them so.

The two are also independent at runtime. A holiday-feed outage degrades the
holiday half only; term context always renders. That ordering is asserted in
`cloudflare-worker/test/calendar.test.js`.

## Consequences

**The term table expires after 2031, and nothing will fetch a replacement.** The
tiered staleness warning is the only mechanism preventing a silent failure at
that point. It is load-bearing, not decoration — do not descope it.

The term table is **deliberately duplicated** from
`tools-site/gas/ClubworxAPI/Code.js`, which keeps its own copy for a different
consumer. That repository is out of scope here and is not to be modified from
this one. The copies were verified identical on 2026-08-05.

Confidence in the hardcoded half comes from two independent sources agreeing:
the derived terms matched the feed's school-holiday blocks 8/8 across 2025–26,
and matched the tools-site table exactly for 2027–29.

Three traps in the feed are handled in code and pinned by tests, because each
one fails silently rather than loudly:

- **All-day end dates are exclusive.** Christmas Day's `DTEND` is Boxing Day.
- **Holidays must not be deduplicated by name.** Anzac Day 2026 legitimately
  occupies both Sat 25 and Mon 27 April; Boxing Day both Sat 26 and Mon 28
  December. Dropping either is a regression.
- **The trailing slash on the feed URL is required**, or the request is
  redirected. The v3.0 JSON API answers 403, hence ICS.

Easter Sunday appearing in the WA list is correct — it is gazetted here — and
should not be "cleaned up" as noise.

Caching uses the platform Cache API rather than KV, so the feature adds no new
binding. The cache key rolls with the Perth date, which is what gives the
roughly-daily refresh. The accepted trade-off: a cache eviction during a long
feed outage shows "holiday info unavailable" rather than stale data.

## Alternatives considered

- **nager.date for holidays.** Rejected: measurably *worse* for WA. It misses
  the actual Anzac Day (Sat 25 Apr 2026) and Boxing Day (Sat 26 Dec 2026),
  listing only the substitute Mondays.
- **The feed for both halves.** Rejected: its school-holiday data ends
  2026-12-18, so term context would vanish within months of shipping.
- **Hardcoding public holidays too.** Rejected: means hand-maintaining
  substitute-day rules every year, which is exactly the work the feed does well.
- **Scraping education.wa.edu.au at request time.** Rejected: the page is
  accordion/JS markup that already produced parse artefacts in testing, and a
  redesign would kill the feature with no fallback.
- **Snapshotting the feed into the repo.** Rejected: never self-corrects. Silent
  staleness is the worst failure mode for this feature.
- **KV for caching.** Rejected: no existing binding, and not worth new infra for
  an advisory feature.
- **Automated drift-checking of the term table against the official page.**
  Considered and dropped in favour of the simplest build. The tiered staleness
  warning is the safety net instead.
