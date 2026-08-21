# `GET /events/:id` is not a route — the answer to #97

Probed against production Clubworx on **2026-08-21**, read-only, 4 GETs per run,
three runs. Answers [#97](https://github.com/urbanjungleirc/staff-site/issues/97),
which asked whether the paste-the-event-id fallback [#67](https://github.com/urbanjungleirc/staff-site/issues/67)
shipped actually works against production.

**It does not.** `GET /api/v2/events/<id>` answers **HTTP 404**, with a JSON body
carrying two fields — `status` and `error` — and an error message of
`"Not Found"`. For a real event id, for an invented one, with the date window
and without it. There is no such route.
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

Body shape, `content-type: application/json; charset=UTF-8` on all three — field
**names** and the error message, which is all the summariser records:

```
fields: ["status", "error"]     error message: "Not Found"
```

The `status` field's *value* is not recorded — the summariser reduces a body to
field names before anything is written — so this document does not quote a
literal body it cannot show evidence for.

### What reproduced, and what did not

The **network behaviour** reproduced on all three runs: 404 on every addressed
call, every time, including one run over a 60-day window whose listing came back
full at 50. The window makes no difference; nothing about the window was ever
the problem.

The **derived findings did not**, and the records say so.
`probes/lib/report.mjs` was still being fixed between runs — three of its fields
reported confident values about an absent route before the gates went in. Run 1
has no `refusal` key at all and `windowRequired: true`; run 2 still has
`discriminates: true`. **Only run 3 corresponds to the shipped classifier.**
Runs 2 and 3 used `--days=3`; the default is 14.

The finding stands on the network facts, which are identical across all three.

### The 404 does not look like a lookup failing

Two lines of evidence, and they are not equally strong.

**The strong one.** A real, currently-listed event id and `999999999` come back
identical — same status, same body shape, same message. Whatever answers is not
reading the id, so it cannot be looking something up and failing to find it.
This carries the finding on its own.

**The weak one, recorded for completeness.** Calls 3 and 4 answer in ~225–300ms
against ~1,850–1,965ms for the `/events` collection read. That looks like a
router rejection — but the *first* addressed call took **1,222 / 1,332 /
1,311ms** across the three runs, never ~285ms, and the fast pair always follows
it on a warmed connection. The comparison is confounded by payload size too:
44–50 rows against a two-field error envelope. The timings are **consistent
with** a routing refusal; they are not evidence for it, and nothing here rests
on them.

So the finding is *there is no route* rather than *the event could not be
found* — resting on the identical answers, not on the clock.

## Path addressing exists in this API — per resource, and not for events

Measured 2026-08-21, same key, same session, within one minute of the events
calls above:

| Call | Answer |
|---|---|
| `GET /members/<a real contact_key>` | **200**, a bare object |
| `GET /members/<a well-formed key belonging to nobody>` | **401** |
| `GET /events/<a real event_id>` | **404** |
| `GET /locations/<a real location_id>` | **404** |
| `DELETE /bookings/<id>` | **works** — measured in [#60](60-member-school-pass-booking.md) |

So path addressing is **not absent from this API and not universal in it** — it
is a property of each resource, and no part of the published reference says
which resources have it. `members` has it for GET. `bookings` has it for DELETE.
`events` and `locations` do not.

That is what makes `events/:id` a reasonable guess and a necessary check at the
same time. The lesson is the one #50 already paid for: *an endpoint nobody has
completed is unproven*, and a plausible pattern from a neighbouring resource is
not evidence about this one.

### `GET /members/<unknown key>` answers 401, not 404

Worth its own heading, because it is [#50](50-membership-less-booking.md)'s trap
on a second endpoint. A well-formed `contact_key` that belongs to nobody does
not come back "not found" — it comes back **401**, the status that reads as *you
are not allowed*, on a request that was perfectly well authorised.

`README.md`'s standing rule — *read an endpoint's parameters before concluding
anything from a 401* — now has a second measured instance behind it, and a
sharper form: **on this API a 401 may be about the identifier, not the
credential.** Anything probing a Clubworx id needs a control call with a known-good
identifier before it reads a 401 as a permissions wall.

## It was not rate limiting, and that was checked

The gym has one key (#47), shared by this tool, the HVT roster Worker and two
active n8n workflows, so "we were cut off for overuse" is a fair first
hypothesis for an unexpected refusal. It is wrong here, and the refutation is
cheap enough to record:

- **No `429` anywhere**, in roughly forty requests across four probe runs and a
  control run. #51 measured that a throttle answers `429` for ~18 seconds and
  often in HTML; neither appeared.
- **Collection reads kept working, interleaved with the 404s** — `GET /events`
  returned **200, 200, 200** in the same run as two `404`s on `events/:id`,
  seconds apart on the same connection. A cut-off cannot be selective by path.
- **`GET /members/<key>` returned 200 in the same minute** as `events/:id`
  returned 404. One path-addressed GET working while another fails rules out the
  key, the quota and the connection in a single comparison.
- **Neither other consumer calls `events/:id` at all.** The HVT Worker reads
  `/events` as a collection and is request-driven — no cron, no scheduled
  handler. The n8n term-enrolment workflow is email-triggered and uses only
  collection endpoints with query filters.

Two things about those consumers are worth knowing anyway, because they *would*
matter under load and neither is visible from here: the HVT roster fans out one
`members/<key>` request **per contact in parallel** (up to ~300 at once, against
a measured ~75/min ceiling), and its `/events`→`/bookings` fallback catches any
error — including a `429` — and immediately issues up to three more requests
rather than backing off.

## What a staff member sees today

The route is deployed. `GET /api/clubworx/events?event_id=<anything>` currently
returns **HTTP 502**:

```json
{"error": "Not Found", "reason": "upstream-error", "upstreamStatus": 404, "view": null}
```

Traced rather than assumed: `resolveEvent` fails at `!res.ok`, so the reason is
`upstreamReason(res)` → `'upstream-error'`, which is not in `index.js`'s
`REFUSALS` set, so `readStatus` maps it to **502**. `readFailure` adds
`view: null` unconditionally.

Two things follow. The **502 is honest** — it says the upstream failed, which is
true, and a page treating 5xx as "something is broken" will do the right thing.
But the **`error` string is not**: `upstreamMessage` passes Clubworx's own
`"Not Found"` through verbatim per D6, so any surface that shows the message
rather than the status tells a staff member who pasted a perfectly valid id that
it was **not found**. That is the more expensive misreading — it sends someone
to re-check an id that was correct.

Worth noting: `resolveEvent`'s own `'event-not-found'` reason — the one that
would map to a 400 — is **unreachable in production**. It is only returned after
a successful upstream read, and there are none.

Nothing here is a fault in the error handling. Every layer reported honestly
what it received; the request underneath was addressed to a route that does not
exist.

## What this leaves open

#97 closes; the follow-up is a **decision on #54**, and it is not this ticket's
to make. The issue states both options:

- **Resolve the pasted id page-side**, from the window the picker already holds.
  The listing is already on screen, and #67 rejected the Worker re-walking that
  window — up to **10** requests (`MAX_PAGES`) of a gym-wide 75/min allowance to
  find an id the page can already see. Nothing in this measurement changes that
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
node probes/run-97.mjs              # 4 reads, 14-day window
node probes/run-97.mjs --days=3     # the window these runs used
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
