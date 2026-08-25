# `uj-clubworx-api` — the staff site's Clubworx Worker

staff-site[#66](https://github.com/urbanjungleirc/staff-site/issues/66), part of
the school group booking map ([#46](https://github.com/urbanjungleirc/staff-site/issues/46)).
Design: `docs/superpowers/specs/2026-08-19-school-group-booking-design.md` §6.

#66 shipped the **skeleton**: the Worker, the Access gate, the pacer and the
request layer. #68 added the dedup read, #69 the write chain, #67 the three
reads the page opens with, and #70 the cancel. **Every route §6 names is now
here.**

| Route | Ticket | Does |
|---|---|---|
| `GET /api/clubworx/health` | #66 | Names the authenticated operator; says whether the secret was put |
| `GET /api/clubworx/contacts?last_name=&dob=` | #68 | Searches all three status views and merges — see below |
| `GET /api/clubworx/events?from=&to=&q=` | #67 | Lists a date window, paged to exhaustion; `?event_id=` resolves a pasted id |
| `GET /api/clubworx/plan?name=School+Pass` | #67 | Resolves the plan name to an id **and its `membership_duration`** — see below |
| `GET /api/clubworx/schools` | #67 | Distinct School marker tags, for the school picker |
| `POST /api/clubworx/student` | #69 | **The only route that creates.** One student, all their sessions — see below |
| `POST /api/clubworx/unbook` | #70 | **The only reversal there is.** Cancels the bookings one run made for one student — see below |

`ACCESS.md` in this directory is the answer to #47: where the key comes from,
where it lives, and what is still owed. Read it first.

## Layout

```text
src/index.js     the Worker: routing, the Access gate, the log line
src/access.js    Cloudflare Access JWT verification against the team JWKS
src/clubworx.js  the only path to Clubworx: paced, redacted, measured shapes
src/contacts.js  the dedup read: all three status views, merged  (#68)
src/events.js    the event picker's read, the lead-time rule, the id fallback (#67)
src/plans.js     name -> membership_plan_id + membership_duration (#67)
src/schools.js   the distinct School marker tags                  (#67)
src/student.js   the per-student write chain, and D3's rollback   (#69)
src/bookings.js  book, cancel, and the error vocabulary           (#69)
src/unbook.js    the cancel route: the interlock, and the re-read (#70)
src/memberships.js  summariseMemberships + D4's pass verdict (promoted, #69)
src/duration.js  the plan's duration, and what a pass covers      (#69)
src/upstream.js  what a Clubworx failure means: retry, report, neither (#69)
src/pace.js      75 req/min, one in flight — the constant #51 measured
src/request.js   buildUrl + redact                (promoted from probes/lib)
src/paging.js    walking a list with no total and no next-page link  (#67)
src/errors.js    errorMessageOf                   (promoted from probes/lib)
test/            vitest, run by hand — this repo runs no tests in CI
probes/          the read-only probes, and what they found
```

`src/request.js`, `src/errors.js`, `summariseMemberships`, `findPlanByName`,
`describeLeadTime` and `pickBookableEvents` were **moved** out of `probes/lib/`,
not copied. The probes import them from here now. They were written against measured
Clubworx behaviour and carry their own test files; a second copy would re-derive
their bugs, and the two would drift on the first fix that only landed in one.

## Auth

**Cloudflare Access.** Access fronts `ujstaff.happyk.au` and injects a signed
`Cf-Access-Jwt-Assertion` header. The Worker **verifies the signature** against
the `happyk.cloudflareaccess.com` JWKS and **fails closed** — it does not trust
the header's presence, and a present-but-invalid token is a rejection rather
than a fallback.

Everything below is a 401, and the client is told only `unauthorized` — the
reason goes to the log, because told apart these reasons describe the gate to
whoever is rattling it:

| Reason | What it was |
|---|---|
| `no-token` | no assertion at all |
| `malformed` | not three decodable segments |
| `unsupported-alg` | anything but `RS256` — `none` and `HS256` are the classic bypasses |
| `unknown-kid` | signed by a key this team does not publish |
| `bad-signature` | forged, or edited after signing |
| `expired` / `not-yet-valid` | outside the token's window, ±30 s of skew |
| `wrong-issuer` | minted by a different Access team |
| `wrong-audience` | minted for a different app **on this team** — every app on `happyk.au` is signed by the same keys |
| `no-email` | valid, but with nobody to attribute a write to |
| `jwks-unavailable` | the key set could not be fetched — a rejection, never a skip |
| `not-configured` | `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` unset |

`workers_dev = false` in `wrangler.toml` is part of this: a `*.workers.dev`
address is not fronted by Access, so leaving it on would publish an
unauthenticated door beside the guarded one.

## What this Worker stores

**Nothing.** No student name or date of birth reaches any Cloudflare store, KV,
D1, or log (§6, D10). There is no run store and no persistence of any kind.

The log line is one JSON object per request carrying the worker name, the
**route path**, the method, the status, the operator email and the elapsed ms —
and on a rejection, the reason.

- **Never the query string.** `GET /contacts?last_name=&dob=` is a route this
  design calls for, so logging a path with its query would put a student's
  surname and date of birth into Cloudflare's log store.
- **Never a body.** One debugging `console.log(body)` is all it would take.

`test/worker.test.js` asserts both directly, because a rule of this shape fails
silently.

## `GET /contacts` — the dedup read

```text
GET /api/clubworx/contacts?last_name=Nowak&dob=2009-03-02
```

Both parameters are **required**, and `dob` must be a real `YYYY-MM-DD` day.
Surname + DOB is the candidate-narrowing key of §5; a surname-less query is a
walk through ~60,000 contacts that can conclude nothing, and a query without a
birthday cannot tell siblings apart. Date orientation is the standing hazard on
this map — `03/02/2009` is two different children depending on who typed it — so
the route takes exactly one form rather than guessing.

```json
{
  "candidates": [
    {
      "contact_key": "…",
      "first_name": "Amelia",
      "last_name": "Nowak",
      "dob": "2009-03-02",
      "email": "noreply+newman@urbanjungleirc.com",
      "status": "Member",
      "status_view": "members"
    }
  ],
  "views": [
    { "view": "prospects", "pages": 1, "rows": 0 },
    { "view": "members", "pages": 1, "rows": 1 },
    { "view": "non_attending_contacts", "pages": 1, "rows": 0 }
  ],
  "requests": 3
}
```

Amelia was created as a prospect and has since taken a membership, so she is in
`/members` now — which is the whole reason all three are searched.

### It searches all three status views

`/prospects`, `/members` and `/non_attending_contacts` are **three disjoint
views by status, not three indexes over one table** ([#49]). A contact appears
in exactly one and *moves between them as their status changes*, so a
prospect-only lookup stops finding a student the moment they take a membership.
That is not hypothetical — it broke the [#60] probe when its own test contacts
were converted. Results merge by `contact_key`.

`status_view` records which of the three held them. Nothing needs it to match;
it is the fact that explains a surprise.

### It does not decide the match

`new` / `matched` / `name-variant` / `ambiguous` is produced by
`school-booking/identity.js`, which is pure so it stays testable. This route
narrows; it does not conclude — and it does not filter the rows Clubworx
returned, because matching runs on **compare form** (§7 P10) and that
normalisation table lives in `school-booking/parse.js`. A second copy here would
drift, and the drift is silent in the worst way: the day the two disagree,
`O'Brien` stops matching `OBrien`, a student who already has a contact comes
back as `new`, and a second permanent contact is written for them. `matchStudent`
re-checks surname *and* DOB against every candidate, so an over-broad set is safe
and a locally-narrowed one is not.

### Every uncertain answer is a refusal

The caller turns an empty candidate set into `new`, and `new` creates a contact
that **Clubworx cannot delete** (`ACCESS.md` §4). The failure modes are not
symmetric: an over-broad candidate set costs a human a second look, a short one
costs a permanent duplicate. So a failure never looks like "nobody found".

| Outcome | Status | `reason` |
|---|---|---|
| A view errored, or answered `200` with a body that is not a list | `502` | `upstream-error` |
| A view was still returning a **full page** at the page ceiling | `502` | `search-not-narrowed` |
| Clubworx throttled | `429` | `throttled` |
| Missing or malformed `last_name` / `dob` | `400` | `bad-request` |
| `CLUBWORX_ACCOUNT_KEY` was never put | `503` | `not-configured` |

A failing view stops the whole search rather than answering from the other two —
the missing view is exactly where the student might be.

`502` rather than the upstream status, because Clubworx answering `401` must not
reach the browser beside the `401` this Worker's own Access gate returns; that
sends an operator to re-authenticate against a problem that is not theirs. The
upstream code travels in `upstreamStatus` instead. Upstream messages are passed
through **verbatim** — [#50] is the cautionary tale for paraphrasing one.

### Paging, and the ceiling on it

A page that comes back **full** is silent truncation: [#51] measured no total,
no next-page link and no header to say more exist, so a full page is
indistinguishable from a complete list. Each view is therefore paged until a
short page arrives — at `page_size=200`, never the default 50 that hid `School
Pass` from [#60].

The walk is bounded at `MAX_PAGES`, and hitting that ceiling is a **refusal**,
not a truncation flag: a flag is something a caller can ignore, and ignoring
this one writes a duplicate contact.

That bound was written against a real unknown — whether Clubworx honoured
`last_name` and `dob` as *filters* at all, the only contact filter ever measured
being `email` ([#49]). An ignored filter would have made this a walk through the
whole database at 75 req/min, minutes per student.

**The filtering does happen server-side** ([#92], 2026-08-20): a live search
returned instead of tripping the ceiling, which is only possible if at least one
filter narrows. So the bound guards an anomaly rather than the expected path.

The open half is worth knowing: whether `last_name` matches **exactly or
partially** is unmeasured, and `probes/README.md` suggests partial. If it is, a
common surname returns more rows than a rare one, and this ceiling is what
stands between that and a silent truncation.

### `dob` is passed through untouched, and that is now measured — [#92]

`dob` leaves the Worker exactly as Clubworx sent it, and `matchStudent` compares
it as a string against `parse.js`'s ISO `YYYY-MM-DD`.

Checked live on 2026-08-20: **a contact reads back with `dob` as ISO
`YYYY-MM-DD`**, no time component — the probe contact returned `1900-01-01`, the
exact string it was written with. The comparison is sound, and **no
normalisation belongs in this route.**

Keep it that way. Had the format been `02/05/1999`, orientation would have been
ambiguous, and normalising on a guess would have made every comparison false,
reported every student `new`, and written a permanent contact for each —
silently. Anyone adding a date transform here is re-opening that.

The same call returned rather than tripping `search-not-narrowed`, which proves
the filtering happens server-side: with both filters ignored, `/prospects` alone
would have answered three full pages. Which of the two narrows, and whether
`last_name` is exact or partial, is still open on [#92] — a sizing question now
rather than a correctness one.

### It does not retry

§11's D8 retries `429`, `5xx` and network errors — but **a `429` pauses the
whole run, not one row**, because the allowance is gym-wide ([#47]) and backing
off a single student while the others continue just spends the next window
failing. Retrying inside the Worker would hide the throttle from the only layer
that can act on it.

So the caller implements D8, and `upstreamStatus` is what it classifies on.
`reason` says what kind of failure it was; `upstreamStatus` says whether D8 may
retry it:

| `upstreamStatus` | Was | D8 |
|---|---|---|
| `429` | throttled | retry after the ~20 s floor — and pause the **whole run** |
| `0` | a connection failure, never an upstream answer | retryable |
| `5xx` | Clubworx erred | retryable |
| `4xx` | Clubworx refused our request | **never retry** — permanent for that attempt |
| `200` | `search-not-narrowed` | not a retry; the query itself is the problem |

`0` rather than `null` for a connection failure is deliberate in `clubworx.js`,
so a caller comparing statuses cannot mistake it for an answer it simply did not
read.

### What a run costs here

**3 requests per student** when each view answers on its first page — so a
25-student list spends ~75 requests on this route alone, against a measured
ceiling of 75/min shared with the roster Worker and n8n. `requests` is on every
response so a run can be held to that budget.

[#47]: https://github.com/urbanjungleirc/staff-site/issues/47
[#49]: https://github.com/urbanjungleirc/staff-site/issues/49
[#50]: https://github.com/urbanjungleirc/staff-site/issues/50
[#51]: https://github.com/urbanjungleirc/staff-site/issues/51
[#60]: https://github.com/urbanjungleirc/staff-site/issues/60
[#67]: https://github.com/urbanjungleirc/staff-site/issues/67
[#92]: https://github.com/urbanjungleirc/staff-site/issues/92
[#97]: https://github.com/urbanjungleirc/staff-site/issues/97

## The #67 read routes — `events`, `plan`, `schools`

All three are read-only, all three **page to exhaustion**, and all three treat a
full page as incomplete rather than as an answer. That is one measured trap
appearing three times: Clubworx sends **no total, no next-page link and no
header**, so a truncated page is indistinguishable from a complete list by
anything in the response ([#51]).

### `GET /events?from=&to=&q=` — the picker

`GET /events` documents `contact_key` as **required**. It is not — [#51]
measured the parameter ignored entirely, and the list gym-wide. That is what
makes a picker possible at all, including for an event nobody has booked into
yet. It is also **undocumented and contradicts the reference**, which is why the
paste-the-id fallback below is a hard requirement rather than a nicety.

- **The date window is required.** Omitting both dates is a `422` with an empty
  body, not "everything". The route validates `from`/`to` as real days and
  refuses `400` rather than spending a request to be told that. They are passed
  through untouched as `event_starts_after`/`event_ends_before`; **whether the
  boundary day itself is in range is unmeasured** — #51 exercised the window's
  presence, not its edges — so a caller wanting the last day of term certainly
  included should ask for the day after it.
- **`q` is matched here, not upstream.** No name filter is measured on this
  endpoint, so sending an invented one risks a filter Clubworx quietly honours
  differently — which returns less than the window holds and looks exactly like
  a thin timetable. `total` is the count before `q` was applied.
- **It annotates; it does not filter.** Every event in the window comes back
  carrying `lead` (the 24-hour rule, D9) and `bookable`. Dropping the unbookable
  ones would be the same silent adjustment D9 rejected: a session missing from a
  picker is invisible, where one greyed out with its reason beside it is a
  decision a human can make. `spaces_available` travels for the same reason and
  is a **warning, never a block** — [#50] measured it wrong in both directions.
- **`?event_id=` resolves a pasted id.** One request to `events/:id`, returning
  its name, date and `spaces_available` so a human can confirm it — a shortcut
  past the *search*, never past the *confirmation*. Anything that is not exactly
  one event with the id that was asked for is `event-not-found`, because if
  `events/:id` is not a route Clubworx may answer with the collection, and taking
  row one out of that confirms the wrong class to an operator.

  **`GET /events/:id` is unmeasured.** Path addressing exists in this API
  (`DELETE /bookings/:id`, [#60]) but has never been exercised here, so whether
  this works against production is an open question a probe should close —
  filed as [#97]. It also does **not** survive Clubworx enforcing the `contact_key` its
  reference documents: that takes `/events` down as a whole, and this route is on
  the same endpoint.

### `GET /plan?name=School+Pass` — where a run dies if it is wrong

`GET /membership_plans` returned **exactly 50** when UJ has **57**, and School
Pass was among the seven that never arrived ([#60]). A lookup on the default page
reports "no such plan" and the whole run stops, for a plan that plainly exists.

- Asks for `page_size=200` and pages to exhaustion. A walk that ends at the
  ceiling still full answers `plan-list-truncated`, **never** `plan-not-found` —
  the two send an operator to completely different places.
- **Refuses an ambiguous name** (`plan-ambiguous`). Two plans sharing a name is
  an error, not a first-wins; assigning the wrong plan is permanent.
- Returns **`membership_duration`** beside the id. `POST /student` takes both
  from its caller and this route is the only source of either. It is a human
  string — `"26 weeks"` — so it travels **verbatim** as well as parsed, and a
  value that will not parse resolves the plan anyway with `duration.ok: false`
  for the page to warn on. Never a silent drop: that check is the only thing
  standing between a shortened plan and a term whose last sessions fall outside
  the pass ([ADR 0005](../docs/adr/0005-school-pass-runs-26-weeks.md)).

**The number 26 is in no source file.** Applying ADR 0005 in Clubworx needed no
code change, and that is the property to keep.

### `GET /schools` — the picker's tags

The distinct **School marker** tags across all three status views — the marker is
the whole `noreply+<school>@` address, the tag is the `<school>` inside it
(`CONTEXT.md` §School marker). Clubworx's email filter partial-matches, so a bare
`noreply+` finds every contact this tool has ever created ([#49]).

**It returns tags, not contacts** — the rows behind the answer are hundreds of
real children, and only the tag, the address to write and a count leave the
Worker.

The cost of a tag missing from this list is not a thin picker: it is a staff
member typing `newmanjhs` beside an existing `newman`, permanently, on contacts
Clubworx cannot delete. That is why it sweeps all three views rather than
reading the default page of one, and why a walk that hits the ceiling comes back
`truncated: true` rather than presenting a partial list as every school there is.

The per-tag `contacts` count is there for the same reason: `newman 63` beside
`newmanjhs 2` is how an operator recognises the second as somebody's typo.

### None of them retries

Deliberately, and the same way `GET /contacts` has not since #68. §11's D8
retries `429`, `5xx` and network errors — but **a `429` pauses the whole run, not
one row**, because the allowance is gym-wide ([#47]) and backing off a single
read while the rest continue just spends the next window failing. Retrying inside
the Worker hides the throttle from the only layer that can act on it. These are
reads: they create nothing, so a caller re-asking is cheap and safe, and failing
fast puts the decision where it belongs. `src/paging.js` carries the same note.

### What these cost

`schools` is the expensive one — 3 views, ~200 contacts a page. `plan`, a
one-term `events` window, and a pasted event id are 1–2 requests each. All three
report `requests`, and the whole gym shares 75 a minute.

## `POST /student` — the per-student write chain

**The only route in this Worker that creates permanent records.** Read
[§12 of the design spec](../docs/superpowers/specs/2026-08-19-school-group-booking-design.md)
before changing any of it.

```jsonc
POST /api/clubworx/student
{
  "student": { "first_name": "…", "last_name": "…", "dob": "2012-03-04",
               "email": "noreply+stbedes@urbanjungleirc.com" },
  "contact_key": null,              // null means "new" — this call creates them
  "membership_plan_id": 64189,      // from GET /plan
  "membership_duration": "26 weeks",// the plan's own string, raw
  "events": [{ "event_id": 101, "starts_at": "2026-09-03T10:00:00+08:00" }],
  "lead_time_acknowledged_event_ids": []   // ADR 0007 — see below. Optional
}
```

```
matched → re-read membership → ensure School Pass → book ×N → verify
new     → create contact WITH the pass ───────────→ book ×N → verify
```

### The lead-time gate is narrowed, never switched off

The chain re-checks the 24-hour lead time per student as a backstop before any
write, and refuses a too-soon session with `reason: "lead-time"` naming the
offending event ids. **`lead_time_acknowledged_event_ids` narrows who that
refusal applies to** — the event ids an operator stated they have lifted the
Clubworx booking restriction for ([ADR 0007](../docs/adr/0007-lead-time-is-an-operator-override.md)).
Everything absent from the list is still refused, with the same reason and the
same ids as before.

It is a list and **never a flag**, and that is the whole safety property. A flag
would also cover a session that crossed into the lead time between selection and
this call — real on a sixty-student list started at 23:40 — and a session the
operator never saw. Both book silently under a flag; under ids both are still
refused, because nobody took responsibility for them.

Three things it deliberately is not:

- **Not an opinion.** D14 still holds: the route hands the list through and the
  chain does not re-validate the event list. An id naming a session this run did
  not select is **inert**.
- **Not a way past an unreadable start.** A session whose `starts_at` will not
  parse is refused as `bad-request` whether it was acknowledged or not — "we
  cannot check this" must never become "you may override this".
- **Not a way past a session that has already started.** Only the lead time is
  a restriction the gym can lift. There is no separate past-session gate here —
  a started session reaches the lead-time comparison as a *negative* delta — so
  the narrowing excludes it explicitly. Its refusal is unchanged: still
  `lead-time`, because nothing about a request carrying no acknowledgements may
  move.
- **Not a change to the minimum.** `MIN_LEAD_HOURS` stays defined once, in
  `src/events.js`, and is imported here. This narrows *who the rule is applied
  to*; it never re-derives what the rule is.

Ids are compared as strings on both sides, so an id that made the round trip as
`"101"` still matches one the picker read as `101`.

### The unit is one student, and it is all-or-nothing

**D2** — a student is the only unit whose failure boundary is a sentence staff
can say out loud: *"the first six are in, the rest are not."* Per-event strands
a child who turns up to session 4 and is not on the list.

**D3** — any failure abandons the student and **cancels the bookings this run
already made for them**. The rollback runs the same code path as the human
"Cancel bookings from this run" control, with no human present, so it honours
the same interlock: act on `booked`, **never** on `already booked`.

It leaves a **stranded student** — a permanent contact and pass, no bookings —
which the response names in `stranded` and `strandedDetail`. Under D3 an
abandoned student is *guaranteed* to be stranded, so it is a routine outcome and
not an edge case.

### `ensure School Pass` means *covers the last session*, not *active today*

The check compares the held pass's `expiration_date` against the **latest
selected session**, inclusive. *Active today* is the answer that hid the original
bug: every booking in a run is written on a day the pass is active, so an
insufficient pass looks perfect at write time and fails weeks later at a session
nobody is watching ([ADR 0005](../docs/adr/0005-school-pass-runs-26-weeks.md)).

| Case | What happens |
|---|---|
| New contact | `POST /members` carrying `membership_plan_id` — one call, pass starts today |
| Returning, pass **covers** the term | skip the grant |
| Returning, pass **expired** | grant |
| Returning, pass **active but not covering** | **`needs-confirmation`** — never a silent second grant |

That last row is [#90](https://github.com/urbanjungleirc/staff-site/issues/90)'s
open question. Granting there means putting a second School Pass on a live
holder, which has deliberately never been probed because memberships have no
delete. Until it is answered the row refuses and a human decides.

**The number 26 is nowhere in the code.** `membership_duration` is read off the
plan and `expiration_date` off the granted pass. The duration is a *human string*
— parsed best-effort, and an unparseable one produces a `warnings` entry naming
the raw value rather than a silently skipped check.

### The error vocabulary

Three distinct refusals share HTTP `400` and `{"error": "…"}`. **The message
string is the only discriminator.**

| Clubworx says | Row outcome |
|---|---|
| *"Woops! You've already booked into this class!"* | **success** — `already booked`. It *is* the idempotency guarantee |
| *"Sorry! This class is now closed for bookings."* | permanent for that event; the lead-time stop should pre-empt it |
| *"Sorry, this class has no free spaces available."* | ambiguous **by construction** — shown as *"Refused — check the session"*, **never** "class full" |
| anything else | `unknown` — **verbatim**, attributed to Clubworx, never retried, never re-worded |

**D6** — paraphrasing an unrecognised message is what makes new Clubworx
behaviour invisible. [#50] is the cautionary tale.

### Every write is verified by re-reading it

Never by the status code. An accepted-but-silent failure and a success are the
same `200`, and this is how [#60] established booking idempotency in the first
place — by counting either side.

- **Contact** — re-read from `/members`; the `contact_key` the chain uses comes
  from that read, not from the create response.
- **Pass** — re-read and re-judged; a grant that produced a pass expiring
  mid-term answers `200` exactly like one that did not.
- **Bookings** — one `GET /bookings?contact_key=` at the end, checked against
  every event attempted.

A retry always re-reads first. A connection error on `POST /members` may have
landed, and retrying blind is how one student becomes two permanent records.

A failed *verification read* is the one case that does **not** roll back: it is
not a failed write, and cancelling good bookings because a read timed out would
destroy the thing being checked. It answers `outcome: "unverified"` with the
rows attached.

### Which statuses leave

Only two things are not a `200`, and in both there is nothing to record:

- **`429`** — a throttle **that wrote nothing**. §11 pauses the *whole run* on a
  throttle, because the allowance is gym-wide.
- **`400`** — a refusal that happened before any write: an **unacknowledged**
  session inside the 24-hour lead time, a pass that will not cover the term, a
  malformed request.

Everything else — including an abandoned, rolled-back student, and including a
throttle that struck *after* something permanent was written — is a `200`
carrying the full result. **A result is not an error.** D10 writes each row to
the browser as it lands because a page reload destroying the only record of a
creation that cannot be undone is the specific failure that defends against, and
a non-200 invites a client to throw the body away. `reason: "throttled"` is in
the body either way, which is what the page should pause on.

### What a run costs here

Per student: 1 membership read (matched only) + 1 write + 1 verification read
+ one booking per event + 1 verification read. A 25-student, 6-session list is
roughly **250 requests** against a 75/min ceiling shared with the roster Worker
and n8n — about four minutes of gym-wide slowdown. `requests` is on every
response.


## `POST /unbook` — the only reversal there is

Body: `{"contact_key": "...", "bookings": [ ...the rows `POST /student` returned ]}`.

The body's `contact_key` may be omitted — it is only ever used to **reject** a
row belonging to somebody else. The key actually sent to Clubworx is never taken
from the body; it comes from the booking row, and it is not optional there.

### What it can and cannot take back

| Record | Reversible? |
|---|---|
| **Booking** | **Yes** — `DELETE /bookings/:id`, measured in #60 |
| **Contact** | **No.** 42 endpoints reviewed, no delete anywhere. Removable only by hand in the Clubworx UI, against a ~60,000-profile database |
| **School Pass membership** | **No.** None appears in the reference and none was attempted. It lapses at `expiration_date` |

So a caller gets its bookings back and nothing else. A student left with a
contact and a pass and no bookings is **stranded**, and under D3's rollback that
is a routine outcome rather than an edge case — which is why **D12: there is no
button called "Undo"**, only *"Cancel bookings from this run"*, with the
permanence of contacts and passes stated beside it.

### The interlock

**It acts on rows marked `booked` and never on rows marked `already booked`.**

This is a **safety interlock, not a display distinction.** Booking is idempotent,
so a re-run marks rows `already booked` — and a cancel scoped to the whole row
set would delete bookings *this run did not create*, possibly a session a real
member booked themselves. #50 identified that as the worst outcome available on
this map.

The rule lives in `cancelRunBookings`, shared with D3's automatic rollback inside
`POST /student`. There is **no flag to relax it**: a rollback path with no human
present is exactly the caller that would set one.

### `contact_key` on the DELETE is not optional

`DELETE /api/v2/bookings/:id` requires `contact_key` **as well as** `account_key`,
form-encoded in the body. Without it the answer is `401 "Authorization failed"` —
indistinguishable from a key with no delete permission, and misdiagnosed as
exactly that for a week in #50, which reported that bookings could not be deleted
at all. **A permissions-shaped error meant a missing parameter.**

The key sent therefore comes from the booking row. A caller-supplied one can be
forgotten (that 401) or, worse, be a different student's — which points a
`DELETE` at somebody else's class. The body's `contact_key`, when present, is
used only to **reject** a row that does not match it.

### One contact per call

A set mixing two contacts is refused before anything is sent:

- **Verification is a re-read of one contact's bookings.** A mixed set could only
  be half-verified, and a half-verified cancel reported as done is the failure
  this route exists to prevent.
- **D1 — the browser drives, one Worker call per student.** The human control
  spans a run, but it loops the way the run itself does. A whole-run cancel in
  one invocation is the multi-minute one-shot response D1 rejected, with the same
  unrecoverable failure mode: writes landed, log lost.

### A `200` proves nothing — the re-read does

#60 confirmed the reversal **by re-count** — 1 booking before, 0 after —
precisely because a status code cannot show a `DELETE` that was accepted and
changed nothing. So every cancel is checked against `GET /bookings?contact_key=`,
and an id still present comes back as `still-booked`, never as cancelled.

Three things about that check:

- **It lives in `cancelRunBookings`, not in this route**, because D3's automatic
  rollback needs it too and is not a route. Putting it here would have left the
  caller with *no human present* trusting a `200`.
- **It matches on the event as well as the booking id**, and the event is the
  load-bearing half. `bookingIdOf` tolerates several shapes because the create
  response's shape was never documented; if a list row carries an id under none
  of them, an id-only check passes having proved nothing. `student.js` verifies
  bookings *landed* by event id for the same reason.
- **A truncated re-read confirms nothing.** The list is walked with `paging.js`,
  and a list that was not read to the end cannot prove a booking is absent from
  it — that comes back `unverified`, never `cancelled`.

The re-read is skipped only when nothing was cancelled: it costs a request
against a gym-wide allowance and there is no claim to check.

`outcome` is one of `cancelled`, `partial`, `nothing-to-cancel`, `still-booked`,
`unverified`, `failed` or `refused` — on every answer, including a rejected body
— and `verified` says whether the re-read actually confirmed it.

### A throttle stops the cancel, it does not push through it

§11 pauses the **whole run** on a `429`, so `cancelRunBookings` stops at the
first one and reports the remaining rows `attempted: false`. Firing them into a
window that is already refusing spends a gym-wide allowance to be told the same
thing again — and comes back reporting bookings as needing a human when they are
still perfectly cancellable. Nothing is retried inside the Worker; the page
re-asks.

### Which statuses leave

The same rule `POST /student` follows. Only two things are not a `200`:

- **`429`** — a throttle **that cancelled nothing**. Once a cancel has landed
  there is a row to record, so it leaves as a `200` carrying
  `reason: "throttled"` — the signal the page pauses the run on.
- **`400`** — a refusal before anything was sent: no rows, or a mixed set.

Everything else is a `200` carrying the full result, including a partial
rollback. **A result is not an error**: the `failed` and `stillBooked` lists are
the only record of which bookings a human still has to remove by hand, and a
non-200 invites a client to throw the body away.


## Pacing

**75 requests per minute, one in flight.** #51 measured ~50 fast requests
followed by ~18 s of `429`, and Clubworx advertises **no rate-limit headers at
all** — not even while throttling — so the pace is a design constant rather than
an adaptive one. Concurrency is the wrong lever: the ceiling is on requests, so
running two at once only reaches it sooner.

The allowance is **gym-wide** — the roster Worker and n8n spend from the same
key (#47) — so being under the ceiling alone is not the same as being under it.

## Deploying

`main` is production on this repo, but a Pages publish does **not** touch this
Worker. It deploys on its own:

```bash
cd cloudflare-clubworx
npm install
npx wrangler secret put CLUBWORX_ACCOUNT_KEY   # once, per environment
npx wrangler deploy
```

Then check the gate from a browser already signed in to the staff hub:

```text
https://ujstaff.happyk.au/api/clubworx/health
```

A healthy answer names the operator Access authenticated, which is what proves
the gate ran rather than proving the Worker is awake:

```json
{
  "ok": true,
  "worker": "uj-clubworx-api",
  "email": "you@urbanjungleirc.com",
  "clubworxKey": "configured",
  "time": "2026-08-19T14:00:00.000Z"
}
```

`"clubworxKey": "missing"` means the secret was never put. The health route
makes no Clubworx call, so it answers `200` either way — it reports the fact
rather than hiding it.

## Tests

```bash
cd cloudflare-clubworx
npm test
```

Run `cloudflare-worker/test/secret-hygiene.test.js` too — it asserts the
repo-wide secret rule for Worker directories *including ones that did not exist
when it was written*, which is this one.

Nothing runs either automatically: `pages.yml` is this repo's only workflow and
it runs no tests. Wiring vitest into CI is `ACCESS.md`'s open recommendation and
is still open.
