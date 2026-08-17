# Probe: event listing without a contact_key, and burst behaviour

Answer to [staff-site#51](https://github.com/urbanjungleirc/staff-site/issues/51),
part of the school-group booking map ([#46](https://github.com/urbanjungleirc/staff-site/issues/46)).
Access and authorisation come from [#47](https://github.com/urbanjungleirc/staff-site/issues/47) — see `../ACCESS.md`.

Ran 2026-08-17 against **production** Clubworx (there is no sandbox). Read-only
throughout: 881 GETs across ten runs, nothing created, updated or deleted.

Reproduce with `node probes/run-51.mjs` — see `README.md` in this directory.

---

## Headline

| Question | Answer |
|---|---|
| Does `GET /events` work without a `contact_key`? | **Yes.** HTTP 200. The parameter is ignored entirely. |
| Is the list gym-wide or scoped to that contact? | **Gym-wide.** Omitted, blank, arbitrary and a real key all return the identical event set. |
| Is anything actually required? | **The date window is.** Omit `event_starts_after`/`event_ends_before` and it is HTTP 422. |
| Does `page_size` work above 50? | **Yes**, verified to 200 — but the default is 50 and a full page is silent truncation. |
| Is there a rate limit? | **Yes, and it is tight.** ~50 requests when spent faster than ~3/s. Undocumented, and unadvertised even while throttling. |
| A concurrency that runs clean? | Concurrency is the wrong lever — see below. **1 in flight at 800ms (75/min)** ran 90 reads clean, twice. |

**The event picker is unblocked.** It can list this week's events directly,
including an event nobody has booked into yet — which was the whole reason the
HVT Worker's derive-from-bookings trick could not be reused here.

---

## 1. Event listing

`GET /api/v2/events` documents `contact_key` as **required**. It is not.

| Request | Status | Events returned |
|---|---|---|
| `contact_key` omitted entirely | 200 | 50 |
| `contact_key=` (present, blank) | 200 | 50 |
| `contact_key=zzzz-not-a-real-contact-key` | 200 | 50 |
| `contact_key=<a real member's key>` | 200 | 50 |
| no date window at all | **422** | — |

All four `contact_key` variants returned the **same event ids**. The parameter
is not merely optional, it is ignored: an arbitrary string that matches no
contact neither errors nor filters. A real member's key returns the same
gym-wide list as no key at all, so `/events` cannot be used to ask "what is this
person booked into" — that is `GET /bookings?contact_key=`, and always was.

The documentation is wrong in the same direction elsewhere, which is mild
corroboration rather than coincidence: `/member_styles` documents `contact_key`
with *"leave blank to return records for all contacts"*, so a blank-means-all-
contacts convention already exists in this API and simply is not written down
on `/events`.

**What is actually required is the date window.** Dropping both date parameters
returns HTTP 422 with an empty body. So the picker always asks for a range,
which is what it wanted to do anyway.

### The 50 that is not a total

Every variant returned exactly 50 events — the default `page_size`. A three-month
window at UJ holds more than that:

| Request | Events |
|---|---|
| default `page_size` | 50 |
| `page_size=200` | 200 |
| `page=2` | 50 |

So the first result was a **truncated page**, indistinguishable from a complete
list by anything in the response — no total, no next-page link, no header.

This is a trap for the picker specifically. A staff member opening "events this
term" and seeing 50 rows has no way to know the session they want is on page 2,
and neither has the page unless it counts. Two rules follow, and they are cheap:

- Request a **narrow window** (the picker wants this week or this term, not a
  quarter), and
- when a page comes back **full**, either fetch the next page or say so. The
  same *"list truncated — narrow by hand"* flag the matching design already
  specifies for candidate lists applies here verbatim.

### Fields available for the picker

`event_id`, `event_name`, `event_start_at`, `event_end_at`, `location_id`,
`location_name`, `free_class`, `instructor_name`, `event_full`,
`spaces_available`, `event_description` — matching the reference exactly.

`spaces_available` and `event_full` are worth noting: a school group of 30 into
an event with 12 spaces is a failure the page can predict before it books
anything, rather than discovering it partway through a batch.

### The paste-the-id fallback is still required

#51 says to build it regardless of this outcome, and that stands. The picker now
has a real listing, but the fallback field is the path that cannot break: it
survives the listing being wrong, the window being wrong, the event being
outside whatever range the picker offers, and Clubworx changing its mind about
an undocumented behaviour this probe is entirely built on.

That last risk is not theoretical. **The behaviour this unblocks is undocumented
and contradicts the published reference.** Nothing stops Clubworx from enforcing
what its own docs say, and the day it does, the picker returns 422 for every
staff member at once. A paste field turns that from an outage into an
inconvenience.

Recorded as a hard requirement on [#54](https://github.com/urbanjungleirc/staff-site/issues/54).

---

## 2. Rate limiting

**There is a rate limit, it is tight, and it is invisible.** Clubworx sends **no
rate-limit headers at all** — not approaching the ceiling, not on the 429 itself.
No `Retry-After`, no `X-RateLimit-*`, nothing. Confirmed under live throttling,
which is stronger evidence than #47's observation on a single clean request: the
API does not advertise a limit even at the moment it is enforcing one.

Every run, at every rate tried:

| Run | Request rate | Result |
|---|---|---|
| 90 reads, 4 concurrent, unpaced | ~4/s | 49 × 200, then **41 × 429** |
| serial unpaced ×4 runs | ~3.4/s | **49 accepted every single time**, then 429 |
| 90 reads paced 150/min | ~1.8/s | 83 × 200, 7 × 429 |
| 90 reads paced 120/min | ~1.7/s | 89 × 200, 1 × 429 |
| 90 reads paced 96/min ×2 | ~1.5/s | **90 × 200, clean, both runs** |
| 90 reads paced 75/min ×2 | ~1.2/s | **90 × 200, clean, both runs** |

Two figures are solid enough to design against:

- **Spent fast, the allowance is ~50 requests.** Four separate serial runs from a
  rested start accepted **exactly 49** before the first 429 — no spread at all.
- **The throttle lifts in about 18 seconds**, measured by polling the cheapest
  read every 5s after the wall. It is not a long ban.

### What the exact shape is — and why this stops short of naming it

The obvious reading is a quota per rolling window, and "50 per 30 seconds" fits
almost everything above. It is not claimed here, because one run contradicts it:
the unpaced 4-concurrent burst put **60 requests through in ~15 seconds**, while
the serial runs were cut off at **50 in ~14.7 seconds**. Same span, different
allowance, so a flat count-per-window is not what is happening. A token bucket
was fitted to those two points and then predicted 429s in the 96/min run that
did not occur, so that is not it either.

Something rate-shaped is being enforced and the published behaviour is not
enough to name the algorithm. Spending more production load to reverse-engineer
it was judged not worth it: the design does not need the algorithm, only a rate
it can trust, and that has been measured directly and reproduced.

**The boundary sits between 96/min and 120/min sustained.** Both rates below it
ran a full 90-read lookup clean, twice each; both above it threw 429s.

### Concurrency is the wrong lever

Four in flight did not survive any better than one — it reached the ceiling
*sooner*, and then failed 41 requests in a row. What separated a clean run from a
throttled one in every test above was the **rate**, never the number in flight.
That follows from the shape of the thing: whatever is being counted, spending it
through four sockets instead of one does not buy more of it.

So the guard the design needs is a **request rate**. Concurrency then becomes a
free choice underneath it — 4 in flight is fine if the rate is capped, and
dangerous if it is not.

This matters because it is the one number in the matching design that was a
guess. Its "bounded concurrency (start at 4 in flight), exponential backoff on
429" was written when no limit was known — and run as written, with no rate cap,
it produces exactly the first row of that table: 49 successes, then 41
consecutive failures. The backoff would eventually rescue it, having already
failed half the list.

### Recommended pacing

**75 requests/minute — one in flight, 800ms apart.** Verified clean twice over a
full 90-read lookup. That is a **37% margin** under 120/min, the slowest rate
observed to throttle, and 22% under 96/min, the fastest verified clean.
`recommendPacing()` in `lib/report.mjs` arrives at the same figure from the raw
measurements, which is a sanity check rather than an independent derivation —
both rest on the same probe.

96/min also ran clean twice and is available if the wait proves intolerable, but
it sits directly against the boundary with no margin for a second system sharing
the key (see below), so 75 is the one to ship.

At 800ms spacing a 30-name lookup (90 reads, per the matching design's call
budget) takes **~74 seconds** — measured, not projected. That is slow enough to
need a progress indicator and a per-run call counter, both already specified, and
it turns the design's "minimise calls" instinct from good practice into the
difference between a minute and five.

Retries must be **backoff, not immediate**. There is no `Retry-After` to obey,
and the observed throttle lasted ~18 seconds from the wall; a retry loop without
a floor of that order will simply spend the next window's allowance failing.

### One consequence beyond this feature

The allowance is almost certainly **per gym key**, and per #47 there is exactly
one key for the whole gym. The HVT roster Worker, any n8n workflow and this tool
all draw on it. A bulk lookup is therefore capable of throttling an unrelated
system, and vice versa — an HVT roster call can fail because this page is
mid-lookup, and nothing in either system's logs would explain why.

This is also why the recommended pace leaves real headroom rather than sitting
at the measured boundary: the margin is not for this tool, it is for whatever
else happens to be talking to Clubworx at the same moment.

Nothing here fixes that; it is recorded because it is invisible in any single
system's code and belongs in the design's failure model
([#53](https://github.com/urbanjungleirc/staff-site/issues/53)).

---

## What this probe did not answer

- **The actual limiting algorithm.** See above: neither a flat count-per-window
  nor a token bucket fits all the measurements. Pinning it down means a lot more
  load on a live gym database to learn something the design does not need, since
  a verified safe rate answers the same question.
- **Whether 429s themselves consume quota.** The recovery poll ran every 5s and
  cleared, so they are at worst not fatal. Unresolved.
- **Whether the limit is per key, per IP, or both.** Only one key and one IP
  were available. Assume per key, since that is the worse case for the shared-
  key consequence above.
- **Write-path limits.** Everything here is reads. Whether `POST /bookings`
  draws on the same allowance is [#50](https://github.com/urbanjungleirc/staff-site/issues/50)'s
  to find out — and if it does, a 30-student booking batch is a 30-request
  write burst that must be paced the same way.
