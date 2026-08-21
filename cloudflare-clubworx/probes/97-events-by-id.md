# `GET /events/:id` is not a route — the answer to #97

Probed against production Clubworx on **2026-08-21**, read-only, 4 GETs per run,
three runs. Answers [#97](https://github.com/urbanjungleirc/staff-site/issues/97),
which asked whether the paste-the-event-id fallback [#67](https://github.com/urbanjungleirc/staff-site/issues/67)
shipped actually works against production.

**It does not.** `GET /api/v2/events/<id>` answers **HTTP 404** with
`{"status": 404, "error": "Not Found"}` — for a real event id, for an invented
one, with the date window and without it. There is no such route.
`resolveEvent` in `../src/events.js` cannot succeed as written, and the paste
field on [#54](https://github.com/urbanjungleirc/staff-site/issues/54) has no
Worker-side route behind it.

| | Question | Answer |
|---|---|---|
| 1 | Is `GET /events/:id` a route? | **No** — 404, `"Not Found"` |
| 2 | Bare object, or one-element array? | **Neither** — an error envelope, fields `status` and `error` |
| 3 | What does a non-existent id answer? | **The same 404** — indistinguishable from a real one |
| 4 | Does the date window requirement follow to the addressed form? | **Unanswerable** — nothing resolves either way |
| 5 | Does #67's `resolveEvent` survive it? | **No** |

Nothing was written. The only verb issued was GET.

## What was measured

Seed listing, `GET /events?event_starts_after=2026-08-20&event_ends_before=2026-08-24&page_size=50`:
**HTTP 200**, 44 events, page not full, so the listing is complete rather than
truncated (#51's rule). First future event id **20013052**, starting
`2026-08-21T16:00:00.000+08:00`.

Then the three addressed calls:

```
GET /events/20013052?event_starts_after=…&event_ends_before=…&page_size=50   404   1332ms
GET /events/999999999?event_starts_after=…&event_ends_before=…&page_size=50  404    286ms
GET /events/20013052?page_size=50                                            404    283ms
```

Body, identical in all three, `content-type: application/json; charset=UTF-8`:

```json
{"status": 404, "error": "Not Found"}
```

Reproduced on three separate runs, including one over a 60-day window whose
listing came back full at 50. The window makes no difference; nothing about the
window was ever the problem.

### The 404 is the router's, not the database's

The two calls that follow a warmed connection answer in **~285ms**, against
**~1,950ms** for the `/events` collection read beside them. Clubworx is not
looking anything up and failing to find it — it is declining to route the
request at all. The identical answer for id `999999999` and for a real,
currently-listed event id says the same thing from the other direction: nothing
here is reading the id.

That is why the write-up says *there is no route* rather than *the event could
not be found*. The distinction is the whole finding.

## Path addressing exists in this API — just not here

`DELETE /bookings/:id` was measured working in [#60](60-member-school-pass-booking.md).
So Clubworx does address individual records by path, which is exactly why
`events/:id` was a reasonable guess, and exactly why it had to be checked rather
than assumed. The API's shape is **inconsistent between resources**, and no part
of the published reference says so.

The general lesson for this map is the one #50 already paid for: *an endpoint
nobody has completed is unproven*, and a plausible pattern from a neighbouring
resource is not evidence about this one.

## What a staff member sees today

The route is deployed. `GET /api/clubworx/events?event_id=<anything>` currently
returns:

```json
{"error": "Not Found", "reason": "upstream-error", "upstreamStatus": 404}
```

`errorMessageOf` reads Clubworx's `error` field, `upstreamMessage` passes it
through verbatim per D6 — and the result is that a staff member who pastes a
perfectly valid event id is told **"Not Found"**. That reads as *"the event
doesn't exist"*, not *"this feature has never worked"*, which is the more
expensive of the two misreadings: it sends someone to check the id they already
know is right.

Nothing here is a fault in the error handling. Every layer reported honestly
what it received; the request underneath it was addressed to a route that does
not exist.

## What this leaves open

#97 closes; the follow-up is a **decision on #54**, and it is not this ticket's
to make. The issue states both options:

- **Resolve the pasted id page-side**, from the window the picker already holds.
  The listing is already on screen, and #67 rejected the Worker re-walking that
  window — up to `MAX_PAGES` requests of a gym-wide 75/min allowance to find an
  id the page can already see. Nothing in this measurement changes that
  reasoning; it removes the alternative.
- **Drop the field.**

What the measurement does settle is that the third option — the one currently
deployed — is not an option. A field wired to a 404 is worse than no field: it
looks like a working escape hatch until somebody needs it.

Note also what page-side resolution *is not*. The paste field was justified as
insurance against the search being unhelpful — a name filtered out, a truncated
window, a long timetable. Resolving from the window the page holds keeps exactly
that much and no more: if the id is outside the window, the page does not have
it either. It never survived `/events` being enforced against its own
documentation (#51), and `resolveEvent`'s header already says so.

## Reproducing

```bash
cd cloudflare-clubworx
node probes/run-97.mjs --dry-run    # the 4 calls, no network, no key needed
node probes/run-97.mjs              # ~4 reads
node probes/run-97.mjs --days=30 --missing-id=123456789
```

`probes/lib/report.mjs`'s `describeEventById` is the part with the judgement in
it, and it is unit-tested. Three of its rules were written because a draft got
them wrong in a way that would have produced a confident, false finding:

- A one-element array carrying the right id **is not proof**. If the path
  segment were ignored and the window held exactly one event, a collection read
  and a genuine resolution would be byte-identical. It needs corroboration — a
  made-up id that answers differently, or a collection wider than what came
  back.
- A `401` leaves the verdict **null, never false**. #50 read a refusal as a
  permissions wall and lost an architectural route for a week.
- `resolveEvent` sends **no date window**, so the windowless call is the one that
  answers for the shipped code. Had `events/:id` turned out to need a window, the
  route would have been reported as working while 422-ing in production.
