# `uj-clubworx-api` — the staff site's Clubworx Worker

staff-site[#66](https://github.com/urbanjungleirc/staff-site/issues/66), part of
the school group booking map ([#46](https://github.com/urbanjungleirc/staff-site/issues/46)).
Design: `docs/superpowers/specs/2026-08-19-school-group-booking-design.md` §6.

#66 shipped the **skeleton**: the Worker, the Access gate, the pacer and the
request layer. #68 added the dedup read. The rest — `events`, `plan`, `schools`,
`student`, `unbook` — arrive with #67, #69 and #70, and answer `404` until then.

| Route | Ticket | Does |
|---|---|---|
| `GET /api/clubworx/health` | #66 | Names the authenticated operator; says whether the secret was put |
| `GET /api/clubworx/contacts?last_name=&dob=` | #68 | Searches all three status views and merges — see below |

`ACCESS.md` in this directory is the answer to #47: where the key comes from,
where it lives, and what is still owed. Read it first.

## Layout

```text
src/index.js     the Worker: routing, the Access gate, the log line
src/access.js    Cloudflare Access JWT verification against the team JWKS
src/clubworx.js  the only path to Clubworx: paced, redacted, measured shapes
src/contacts.js  the dedup read: all three status views, merged  (#68)
src/pace.js      75 req/min, one in flight — the constant #51 measured
src/request.js   buildUrl + redact                (promoted from probes/lib)
src/errors.js    errorMessageOf                   (promoted from probes/lib)
test/            vitest, run by hand — this repo runs no tests in CI
probes/          the read-only probes, and what they found
```

`src/request.js` and `src/errors.js` were **moved** out of `probes/lib/`, not
copied. The probes import them from here now. They were written against measured
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
[#92]: https://github.com/urbanjungleirc/staff-site/issues/92

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
