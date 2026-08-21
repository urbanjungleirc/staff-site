# Clubworx probes

Small scripts that answer a specific question about the live Clubworx API, and
the write-ups of what they found. They exist because the API reference is
incomplete and occasionally wrong, and because **Clubworx has no sandbox** — the
only way to learn how it behaves is to ask it, carefully, in production.

| File | What it answers |
|---|---|
| `51-events-and-burst.md` | [#51](https://github.com/urbanjungleirc/staff-site/issues/51) — event listing without a `contact_key`, and rate limits |
| `run-51.mjs` | The probe that produced it — read-only |
| `49-plus-addressed-duplicates.md` | [#49](https://github.com/urbanjungleirc/staff-site/issues/49) — plus-addressed `noreply@`, duplicate emails, and whether a tag isolates a school |
| `run-49.mjs` | The probe that produced it — **writes** |
| `50-membership-less-booking.md` | [#50](https://github.com/urbanjungleirc/staff-site/issues/50) — **no**, a prospect cannot be booked: Clubworx applies a per-contact allowance the API cannot pass, and `spaces_available` does not predict it |
| `run-50.mjs` | The probe that produced it — **writes** |
| `60-member-school-pass-booking.md` | [#60](https://github.com/urbanjungleirc/staff-site/issues/60) — the member + **School Pass** route **works**: it books, the server refuses duplicates itself, and `DELETE` reverses cleanly |
| `run-60.mjs` | The probe that produced it — **writes, and deletes** |
| `63-member-creation.md` | [#63](https://github.com/urbanjungleirc/staff-site/issues/63) — the gate on the #46 build: does `POST /api/v2/members` create a contact, is it bookable, and can the School Pass ride along on the create call |
| `run-63.mjs` | The probe that produced it — **creates contacts, assigns passes, books and cancels** |
| `97-events-by-id.md` | [#97](https://github.com/urbanjungleirc/staff-site/issues/97) — is `GET /events/:id` a route, and does #67's paste-the-id fallback survive whatever it is |
| `run-97.mjs` | The probe that produced it — read-only, 4 reads |

A file's number is the issue it answers, so `63-member-creation.md` belongs to
[#63](https://github.com/urbanjungleirc/staff-site/issues/63). That ticket's own
*Done when* line asks for `61-member-creation.md`, written before the issue was
renumbered — there is no #61, and a file named for it would point at nothing.

Access, authorisation and the key's whereabouts: `../ACCESS.md`.

## Running

Needs `../.dev.vars` with `CLUBWORX_ACCOUNT_KEY` — see ACCESS.md section 1.

```bash
cd cloudflare-clubworx
npm install

node probes/run-51.mjs --dry-run     # what it would call, without calling
node probes/run-51.mjs               # event listing, pagination, burst  (~100 reads)
node probes/run-51.mjs --calibrate   # find the ceiling, then verify a pace (~5 min)
node probes/run-51.mjs --walls=3     # measure the ceiling repeatedly
node probes/run-51.mjs --pace-per-min=96   # is this rate sustainable?

node probes/run-49.mjs --dry-run     # the plan and every request, zero network
node probes/run-49.mjs               # read-only: search, then the isolation reads
node probes/run-49.mjs --write       # ⚠️ creates up to 3 PERMANENT contacts

node probes/run-50.mjs --dry-run     # the plan and every request, zero network
node probes/run-50.mjs               # read-only: finds #49's contacts, lists bookable events
node probes/run-50.mjs --event=<id> --write         # ⚠️ books a real class
node probes/run-50.mjs --event=<id> --free-event=<id> --write
node probes/run-50.mjs --cancel=<booking_id> --write # tries to remove a probe contact's booking

node probes/run-60.mjs --dry-run     # the plan and every request, zero network
node probes/run-60.mjs               # read-only: contacts, plan, memberships, event
node probes/run-60.mjs --event=<id> --write  # ⚠️ assigns a PERMANENT School Pass, then books

node probes/run-63.mjs --dry-run     # the plan and every request, zero network
node probes/run-63.mjs               # read-only: what exists already, and the plan lookup
node probes/run-63.mjs --event=<id> --write  # ⚠️ creates up to 2 PERMANENT contacts + 2 passes
node probes/run-63.mjs --encoding=form       # force the body shape rather than discovering it

node probes/run-97.mjs --dry-run     # the 4 calls, zero network — and no key needed
node probes/run-97.mjs               # read-only: is events/:id a route, and what shape
node probes/run-97.mjs --missing-id=<id>     # choose the id that should not exist

npm test                             # the pure logic, no network
```

`--dev-vars=<path>` points any probe at a key outside the package — a git
worktree, for instance, where `.dev.vars` is gitignored and so does not follow
the checkout.

**No booking probe picks the event itself.** `--write` without
`--event=<id>` stops. A booking lands on a real class that staff see and consumes
one of its spaces, so choosing by sort order means choosing somebody's actual
session; a read-only run lists the candidates and a human picks one. Everything
they book, they cancel — and they print anything they could not.

**Book into a purpose-made test event.** Whether a contact can book is a property
of *the event's configuration*, not of the API — which of these applies depends
entirely on how the session is set up, and a generic open-climb session answers a
different question to the one #46 needs.

**`GET /events` cannot tell you which is which.** Its fields are `event_id`,
`event_name`, `event_start_at`, `event_end_at`, `location_id`, `location_name`,
`free_class`, `instructor_name`, `event_full`, `spaces_available` and
`event_description` (verified 2026-08-18) — there is **no event-type field**, and
nothing exposing what a session requires of a bookee. So #46's picker cannot
pre-validate a booking; it finds out by trying, and must read the message that
comes back. The three known refusals are tabulated in
`60-member-school-pass-booking.md`.

Runs write a JSON summary to `probes/out/`, which is gitignored.

## The rules these scripts follow

Every one of them is a consequence of *production, public repo, no sandbox*.

- **Read-only unless the ticket says otherwise.** There are four ways out to
  Clubworx and they are separate files on purpose. `lib/http.mjs` issues GET and
  nothing else, so a probe that imports only it *cannot* write — that is a
  property of the script, not a claim about it. Creating a contact means reaching
  for `lib/write.mjs` deliberately, booking or cancelling means `lib/booking.mjs`,
  and assigning a membership means `lib/membership.mjs`.
- **`DELETE` is guarded harder than `POST`, because it is the worse mistake.**
  `lib/booking.mjs` refuses any booking id it did not create itself or have
  explicitly vouched for against a probe contact — there is no way to hand it an
  arbitrary id. Cancelling a real member's class takes somebody off a session
  they turn up to.
- **Only bookings can be undone.** Contacts cannot be deleted, and memberships
  have no delete either — a School Pass lapses at its `expiration_date` and is
  otherwise permanent. `DELETE /bookings/:id` does reverse a booking (#60,
  verified by re-reading rather than by the status), but it needs `contact_key`
  in a form-encoded body; without it the answer is `401 "Authorization failed"`,
  which #50 read as a permissions wall and wrote up as one. **Read an endpoint's
  parameters before concluding anything from a 401**, and treat any endpoint
  nobody has actually completed as unproven.
- **A full page is not an answer.** `GET /membership_plans` returned exactly 50
  of UJ's 57 plans and hid the one being looked for; `/events` does the same
  (#51). Always pass a `page_size`, and treat a page that comes back full as
  truncated rather than complete.
- **Two controls in front of every write**, because Clubworx **cannot delete
  contacts through the API** and there is no sandbox. `createPoster` is inert
  unless `live` is explicitly true, so a forgotten flag costs nothing; and every
  contact must pass `lib/identity.mjs`'s guard *before* the network is touched,
  so a write under anything resembling a real name is refused rather than
  reported afterwards. Write probes are authorised in ACCESS.md section 4, and
  the identity set there is the whole blast radius.
- **A write probe must search first and reuse what it finds.** Re-running one
  should cost nothing permanent. `planContacts` is what makes that true, and it
  matches on surname *and* email — a stranger who happens to share the probe
  address is not the probe's record.
- **Never record a row of production data.** Responses are reduced to counts,
  ids, field names and timings by `lib/report.mjs` before anything is printed or
  written. Clubworx holds ~60,000 real people and this repo is public and
  rsynced to a live site by `pages.yml`. `probes/out/` is gitignored as a second
  line, but the first line is that there is nothing sensitive in it to begin
  with.
- **No real names in the repo, including as test inputs.** The burst probe
  queries two-letter fragments rather than a surname list. `last_name` is a
  partial match, so they cost exactly what real surnames would.
- **The key never reaches the output.** `redact()` covers the percent-encoded
  form too, and error paths run through it as well — node interpolates the URL
  into its own connection errors.
- **Pace it.** The API allows roughly 50 requests spent quickly, sends no
  rate-limit headers at all, and 429s for ~18 seconds. Anything new should stay
  at or under **75 requests/minute** — see `51-events-and-burst.md`.

## Layout

```
../src/request.js URL building and redaction        (unit tested)
../src/errors.js  a refusal, read safely            (unit tested)
lib/report.mjs    response → publishable summary    (unit tested)
lib/key.mjs       where the live key comes from     (unit tested)
lib/http.mjs      the read path to Clubworx: GET    (unit tested)
lib/write.mjs     the write path: POST, guarded     (unit tested)
lib/booking.mjs   the booking path: POST + DELETE,  (unit tested)
                  guarded harder — see below
lib/membership.mjs  assigning a membership: POST,    (unit tested)
                  permanent, so guarded like a write
lib/identity.mjs  who a write may be, and what to   (unit tested)
                  create given what already exists
run-51.mjs        the #51 probe itself — read-only
run-49.mjs        the #49 probe itself — writes
run-50.mjs        the #50 probe itself — writes and deletes
run-60.mjs        the #60 probe itself — writes and deletes
run-63.mjs        the #63 probe itself — creates contacts,
                  assigns passes, books and deletes
run-97.mjs        the #97 probe itself — read-only
```

`run-97.mjs` loads the key **after** its `--dry-run` branch rather than before,
which is the one place these runners differ. A dry run is what somebody reads
*before* deciding to point a script at production, and that reader is the one
least likely to have a key in place yet; the others refuse to describe
themselves without one.

The two `../src/` entries are not probe files any more. staff-site#66 promoted
them into the Worker's own module, because the Worker needs exactly the same URL
construction, the same redaction and the same way of reading a refusal — and a
second copy would re-derive their bugs and then drift on the first fix that
landed in only one of them. The probes import them from there; their tests moved
with them, to `../test/`.

The libraries are tested and the runner is not. That split is deliberate: the
runner's job is to talk to a live API, which a unit test cannot do, so
everything with a decision in it — what to ask for, what may be written down,
what a burst means — was pushed into a library that can be tested without the
network.
