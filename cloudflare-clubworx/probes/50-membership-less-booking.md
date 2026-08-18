# Booking a membership-less prospect — the answer to #50

Probed against production Clubworx on **2026-08-18**, into a purpose-made test
event (`20481679`, "test school booking") created for this probe. **The probe
created nothing**: two booking attempts, both refused by the server, and one
`DELETE`, also refused.

One booking does exist — `63499414`, made by hand in the Clubworx UI while
diagnosing why the API refused. It is still there, because the API cannot remove
it. See [Cleanup](#-cleanup--delete-these-by-hand).

**The prospect route does not work, and #46's central assumption fails.** The
feature was designed on the premise that a freshly created prospect can be
booked into an event. It cannot — not because of anything in the documented
API, but because Clubworx applies a **per-contact safety rule to prospects**
that the API neither documents nor reports honestly.

**And nothing written through this key can be taken back.** `DELETE
/api/v2/bookings/:id` — which ACCESS.md recorded as the one reversible write on
this map — answers **401 "Authorization failed"** for a key that reads and
creates without complaint. So a mistaken booking is as permanent as a mistaken
contact.

This is the branch #50 asked to be flagged rather than absorbed. It is flagged
in [What this costs #46](#what-this-costs-46).

## The four questions

### 1. Does booking a membership-less prospect succeed? — **No**

`POST /api/v2/bookings` with `{ contact_key, event_id }` was refused:

```
HTTP 400   "Sorry, this class has no free spaces available."
```

The event was configured **to allow prospects to book**, and in the same minute
`GET /api/v2/events` described it as:

| Field | Value |
|---|---|
| `spaces_available` | **25** |
| `event_full` | **false** |
| `free_class` | `false` |

Run twice, same result. The contact held **zero** bookings at the time, verified
by `GET /bookings?contact_key=` immediately before and after each attempt.

### 2. What does it require? — **Not a free class. A per-contact prospect allowance.**

The probe could not answer this from the API alone, and the `free_class`
comparison #50 proposed was never run — see [What is still
unproven](#what-is-still-unproven). What answered it was the **Clubworx UI**.

Booking the same contact into the same event by hand produced a warning that
*the prospect had already booked once to an event*, and asked for confirmation
to book them again (Jiri, 2026-08-18). Confirming it worked — the booking
exists, as `63499414`.

So the block is **not** capacity, and **not** `free_class`. It is a safety rule
counting *how many events this prospect has been booked into*, applied per
contact rather than per event. The UI offers a human an override. **The API
offers none**, and reports the refusal as a spaces problem.

That last part is the trap. The API's stated reason is not merely vague, it
points somewhere else: anyone debugging this from the API alone would go looking
at event capacity, which is not where the problem is, and which the API itself
reports as healthy.

### 3. Does booking the same contact twice duplicate? — **Unasked**

Nothing landed, so there was no first booking to duplicate. Asking it after a
rejection would have measured two rejections and called it idempotency.

### 4. Does `DELETE /bookings/:id` reverse a booking? — **No. It is refused.**

The probe created nothing to cancel, but the UI attempt left booking
`63499414` on `Ztest Wayfinder`, which answered the question at no cost:

```
DELETE /api/v2/bookings/63499414   →   HTTP 401   "Authorization failed"
```

The booking was still there afterwards — verified by re-counting, not assumed
from the status.

**This is not a bad key.** In the same run, with the same key and the same
`account_key` query parameter, `GET /bookings?contact_key=` answered **200**,
and in the runs above `POST /bookings` reached **business-level validation**
(a 400 about spaces, not an auth error). So the key authenticates, and is
permitted to read and to create. It is refused **only on delete**.

Whether that is a per-key permission scope or a property of the API, this probe
cannot say. The consequence is the same either way.

**ACCESS.md said the opposite, and has been corrected.** It recorded bookings as
"the exception — `DELETE /api/v2/bookings/:id` exists, so the booking half of
probe #50 is reversible". That came from the endpoint being in the reference,
not from anyone calling it. It is now measured.

So **nothing this key writes can be removed through the API.** Bookings sit
beside contacts: permanent, and clearable only by hand in the Clubworx UI.

## `spaces_available` cannot be trusted

Independent of everything above, and true whatever shape the tool ends up
taking:

> A booking can be refused **for spaces** by an event that reports 25 spaces
> free and `event_full: false`.

#46's picker was going to use `spaces_available` to warn staff before booking —
"a school group of 30 into an event with 12 spaces is a failure the page can
predict" ([#51's findings](51-events-and-burst.md)). It can still predict *that*
failure, but it **cannot** predict this one: the number it reads is not the
number the booking endpoint enforces against. A session showing plenty of room
can refuse every student in the group.

There is no field on `GET /events` that exposes the prospect allowance — the
response carries `event_id`, `event_name`, `event_start_at`, `event_end_at`,
`location_id`, `location_name`, `free_class`, `instructor_name`, `event_full`,
`spaces_available`, `event_description`, and nothing else. So the tool cannot
pre-validate a booking. It finds out by trying.

## What this costs #46

#50: *"If a membership or plan is required, the shape of the tool changes
materially — it would have to assign a membership plan as well as create a
contact, which is a new decision about cost, plan choice, and what that does to
Clubworx reporting. Flag that loudly rather than absorbing it."*

**Flagging it.** The prospect approach is not viable as designed:

- A prospect gets a small number of bookings before Clubworx blocks further
  ones. A school group is one booking *per student*, so the limit is reached
  immediately for any returning student.
- The override exists **only in the UI**. An automated tool has no way to
  confirm past it.
- The refusal is indistinguishable, from the API, from a genuinely full class.

The direction proposed instead (Jiri, 2026-08-18): create the student as a
**member** holding a dedicated *school booking* membership, configure the
session so that only holders of that membership may book, then book the student
in. That replaces a safety rule the tool cannot pass with one it controls.

It is a **new decision, not an implementation detail** — it changes what the
tool creates, and it needs answers on:

- **Cost** — what a school-booking membership costs, and whether creating one
  per student has a billing consequence.
- **Plan choice** — which plan, with what duration and what it entitles.
- **Clubworx reporting** — a cohort of members created per school changes member
  counts, retention and revenue reporting in ways prospects did not.
- **Cleanup** — memberships are very likely as permanent as everything else.
  Every write this key has been shown to make is irreversible through the API,
  and there is no reason to expect memberships to differ. Assume they cannot be
  removed until measured.

The no-undo finding raises the cost of getting this wrong. A tool that books a
school group of 30 into the wrong session cannot retract it: someone clears 30
bookings by hand in the Clubworx UI. That argues for the tool checking existing
bookings before writing, and for a confirmation step that shows exactly what is
about to be created — which is only possible if question 3 is answered first.

Until those are settled, #52–#55 are designing against an approach this probe
has shown does not work.

## What is still unproven

- **The `free_class` comparison was never run.** The three `free_class` events
  in the window each had exactly one space and belonged to a third-party
  trainer, so booking one would have taken the last place in a real class. It
  was skipped deliberately. Since the mechanism turned out to be per-contact,
  the comparison would probably not have been informative anyway — but that is
  a prediction, not a measurement.
- **The exact prospect allowance is unknown.** The UI said "booked once"; how
  many bookings a prospect gets before the block applies, and whether cancelled
  bookings count against it, were not measured.
- **Whether the member-with-membership route works** has not been probed at all.
  It is a proposal, not a finding.
- **Question 3 — duplicate bookings — remains open**, and matters more now than
  when it was written. It was a tidiness question while `DELETE` was believed to
  work; with no undo, a tool that double-books has no way to correct itself. It
  needs answering before anything books in bulk.
- **Why `DELETE` is refused** — a per-key permission scope, or an API-wide rule —
  was not established. Only that it is refused.

## How it was run

```bash
node probes/run-50.mjs --dry-run                    # the plan, zero requests
node probes/run-50.mjs                              # read-only: contacts, then bookable events
node probes/run-50.mjs --event=20481679 --write     # the two booking attempts above
node probes/run-50.mjs --cancel=63499414 --write    # question 4
```

`--cancel` searches for the booking on a probe contact **before** it will touch
it, which is why it takes a booking id and still goes looking. An id on its own
is not evidence of whose booking it is, and this is the one operation on the map
that could take a real member off a class they turn up to.

14 requests across all runs, paced at one per 800ms (~75/min) per #51. The
probe creates **no contacts** — ACCESS.md §4's three-contact authorisation is
spent, and #50 reuses what #49 left behind; the runner stops rather than
creating a fourth.

The event is never chosen automatically: `--write` without `--event=<id>`
refuses to run. A booking lands on a real class that staff see, so choosing one
by sort order means choosing somebody's actual session.

`lib/booking.mjs` is the only path here that can book or cancel. `book` is
gated on an allowlist of contact keys that passed the identity guard, and
`cancel` refuses any booking id it did not create or have explicitly vouched
for — cancelling a real member's class is the worst outcome available on this
map, and it is guarded harder than creating one.

## ⚠️ Cleanup — delete these by hand

Booking **`63499414`** is still on `Ztest Wayfinder`
(`e35218ef-4e96-4928-a05f-1c14f56e574f`), on test event `20481679`. It was made
by hand in the UI, not by this probe, and the API **cannot remove it** — that is
question 4's answer. It must be cancelled in the Clubworx UI.

The three `Ztest` contacts from [#49](49-plus-addressed-duplicates.md) remain
permanent and are still owed a manual deletion there too.

Test event `20481679` ("test school booking", 2026-08-19 12:00) was created for
this probe and can go once the booking is off it.
