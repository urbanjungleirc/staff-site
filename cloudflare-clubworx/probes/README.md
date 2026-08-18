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
| `50-membership-less-booking.md` | [#50](https://github.com/urbanjungleirc/staff-site/issues/50) — **no**, a prospect cannot be booked: Clubworx applies a per-contact allowance the API cannot pass, `spaces_available` does not predict it, and **`DELETE` is refused, so no write here has an undo** |
| `run-50.mjs` | The probe that produced it — **writes** |

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
node probes/run-50.mjs --event=<id> --write         # ⚠️ books a real class — and CANNOT undo it
node probes/run-50.mjs --event=<id> --free-event=<id> --write
node probes/run-50.mjs --cancel=<booking_id> --write # tries to remove a probe contact's booking

npm test                             # the pure logic, no network
```

`--dev-vars=<path>` points any probe at a key outside the package — a git
worktree, for instance, where `.dev.vars` is gitignored and so does not follow
the checkout.

**`run-50.mjs` never picks the event itself.** `--write` without `--event=<id>`
stops. A booking lands on a real class that staff see and consumes one of its
spaces, so choosing by sort order means choosing somebody's actual session; the
read-only run lists the candidates and a human picks one. Everything it books,
it cancels — and it prints anything it could not.

**Book it into a purpose-made test event.** Whether a membership-less prospect
can book is a property of *the event*, not of the API: UJ's school sessions are
configured with a limited number of prospect places, which is what stops
somebody booking into a school group by accident on the day. An open-climb
session is configured differently, so a booking there answers a different
question to the one #46 needs. Create an event configured like a school session
and pass its id.

`GET /events` **does not expose that allowance** — its fields are `event_id`,
`event_name`, `event_start_at`, `event_end_at`, `location_id`, `location_name`,
`free_class`, `instructor_name`, `event_full`, `spaces_available` and
`event_description` (verified 2026-08-18). So #46's picker cannot pre-validate
it: a session whose prospect places are used up looks exactly like one with
room, and the tool only finds out when a write is rejected.

Runs write a JSON summary to `probes/out/`, which is gitignored.

## The rules these scripts follow

Every one of them is a consequence of *production, public repo, no sandbox*.

- **Read-only unless the ticket says otherwise.** There are three ways out to
  Clubworx and they are separate files on purpose. `lib/http.mjs` issues GET and
  nothing else, so a probe that imports only it *cannot* write — that is a
  property of the script, not a claim about it. Creating a contact means reaching
  for `lib/write.mjs` deliberately, and booking or cancelling means reaching for
  `lib/booking.mjs`.
- **`DELETE` is guarded harder than `POST`, because it is the worse mistake.**
  `lib/booking.mjs` refuses any booking id it did not create itself or have
  explicitly vouched for against a probe contact — there is no way to hand it an
  arbitrary id. Cancelling a real member's class takes somebody off a session
  they turn up to.
- **Nothing written here can be undone.** #50 measured `DELETE /bookings/:id` at
  **401 "Authorization failed"** on a key that reads at 200 and creates without
  complaint. Bookings were previously believed to be the one reversible write on
  this map; they are not. Plan every write as permanent, and assume the same of
  any endpoint nobody has actually called.
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
lib/request.mjs   URL building and redaction        (unit tested)
lib/report.mjs    response → publishable summary    (unit tested)
lib/key.mjs       where the live key comes from     (unit tested)
lib/http.mjs      the read path to Clubworx: GET    (unit tested)
lib/write.mjs     the write path: POST, guarded     (unit tested)
lib/booking.mjs   the booking path: POST + DELETE,  (unit tested)
                  guarded harder — see below
lib/identity.mjs  who a write may be, and what to   (unit tested)
                  create given what already exists
run-51.mjs        the #51 probe itself — read-only
run-49.mjs        the #49 probe itself — writes
run-50.mjs        the #50 probe itself — writes and deletes
```

The libraries are tested and the runner is not. That split is deliberate: the
runner's job is to talk to a live API, which a unit test cannot do, so
everything with a decision in it — what to ask for, what may be written down,
what a burst means — was pushed into a library that can be tested without the
network.
