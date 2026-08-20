# Creating a member, and the pass that rides along — the answer to #63

Probed against production Clubworx on **2026-08-20**, into the same purpose-made
School Session [#60](60-member-school-pass-booking.md) used (`20481679`, "test
school booking", moved to 2026-08-28 so it cleared the lead-time rule).

**Every one of the four answers is yes, and the best case won.** `POST
/api/v2/members` creates a contact, the contact books once it holds a School
Pass, `membership_plan_id` on the create call produces a *usable* pass — and the
start date it receives is the same one the two-call route was sending anyway. The
trade-off §2 of the design spec was braced for **does not exist**.

| | Question | Answer |
|---|---|---|
| 1 | Does `POST /api/v2/members` succeed? | **Yes** — HTTP **200**, JSON body |
| 2 | Is the resulting contact bookable with an active School Pass? | **Yes** — both routes booked |
| 3 | Does `membership_plan_id` on create produce a usable pass? | **Yes** — active immediately |
| 4 | What `start_date` does that pass get? | **The creation day** — identical to the two-call route |

**A new student is two writes, not three.**

Nothing was left outstanding: both bookings were created and then cancelled,
verified by re-count. Four permanent records were added — two contacts and two
School Passes. See [Cleanup](#cleanup).

## 1. `POST /api/v2/members` works — and answers 200

`Ztest Wayfinderfour` ("D") was created with only the four fields the reference
marks required: `first_name`, `last_name`, `email`, plus `dob` for the probe
identity, with `account_key` in the query string.

**HTTP 200, not 201** — exactly as [#49](49-plus-addressed-duplicates.md) found
for `POST /prospects`. A client testing for `201` reads a successful create as a
failure. The verdict here came from re-reading all three status views, not from
the number.

### The body was **JSON**, and that is what is measured

#63 quotes the reference as saying form-encoded. This probe tried **JSON first**,
because JSON is the only contact-create shape anyone on this map has ever
watched work (#49, `POST /prospects`), and the reference has been wrong twice
already. It answered 200 on the first attempt, so the form-encoded fallback
never ran.

> ⚠️ **Form-encoded on `/members` is therefore still untested**, and can no
> longer be tested cheaply: D and E now exist, and the probe reuses them rather
> than creating more. Build the Worker (#69) on **JSON**, which is measured.
> Do not "fix" it to form-encoding on the strength of the reference.

`lib/write.mjs` grew an `encoding` option for this, defaulting to `json` and
throwing on anything it does not recognise. A re-read sits between the two
attempts, so the fallback can never turn a create that quietly worked into a
permanent duplicate.

### A contact created this way is a **member with no membership**

D appeared in `GET /members` **immediately, before any pass was assigned** —
and `GET /memberships?contact_key=…` returned nothing for it at that moment.

That is worth stating plainly, because it refines
[#49](49-plus-addressed-duplicates.md)'s finding that the three contact
endpoints are disjoint views *by status*. They are — but the status is set by
**the endpoint that created the contact**, not derived from whether a membership
is held. "Member" is a label, not a computed consequence of holding a pass.

The design spec's reasoning in §2 ran the other way: it assumed a pass would be
what *moved* a contact into `/members`. It reached the right conclusion, for a
reason that turns out not to be the mechanism. The practical effect is the same
and better — no move is needed, because the contact starts there.

## 2. It books

Both contacts were booked into School Session `20481679` (25 spaces, 191h
ahead, comfortably outside the one-day rule #60 measured), then cancelled.

| Contact | How it got its pass | Book | Bookings after | Cancel | Bookings after |
|---|---|---|---|---|---|
| D `Wayfinderfour` | `POST /memberships` (two-call) | **200**, `63558070` | 0 → **1** | **200** | 1 → **0** |
| E `Wayfinderfive` | `membership_plan_id` on create (one-call) | **200**, `63558071` | 0 → **1** | **200** | 1 → **0** |

Every one of those transitions was read back off the contact's booking list. The
status codes agreed this time, but they were not what was trusted.

**The pass is what makes a contact bookable, and its origin does not matter.**
A pass assigned by the separate call and a pass granted by the create call
produced booking results indistinguishable from each other.

## 3 and 4. The pass rides along, on terms nobody has to give up

`Ztest Wayfinderfive` ("E") was created with `membership_plan_id: 64189` in the
same call. One membership came back — exactly one, not a duplicate — and it was
active the moment it was read.

| | D — two calls, `start_date` sent | E — one call, no `start_date` sent |
|---|---|---|
| `start_date` | 2026-08-20 | **2026-08-20** |
| `expiration_date` | 2026-11-11 | **2026-11-11** |
| Span | 83 days | **83 days** |
| Active on read | yes | **yes** |
| `class_access` | Unlimited classes | Unlimited classes |
| Writes to get here | **2** (`/members` + `/memberships`) | **1** (`/members`) |

**Clubworx defaults the start date to the day of creation** — which is precisely
the value the two-call route was computing and sending. The spec's worry, *"the
pass would start whenever Clubworx decides"*, is answered: it decides *today*,
and today is what we wanted.

**The 12-week plan expires on day 83, not day 84.** 2026-08-20 → 2026-11-11 is
83 days of difference and 84 days of access, because `expiration_date` is
inclusive (#60). The tool still never computes an expiry — it reads one — so
this is a fact to recognise, not one to reproduce.

## What this settles for #46

**Adopt the one-call route for new students.** A student who is not already in
Clubworx is created and given their School Pass in a **single** `POST
/api/v2/members` carrying `membership_plan_id`.

Three things follow:

- **Three writes per new student become two.** On a 63-student list that is 63
  fewer requests against a gym-wide rate ceiling measured at ~75/min (#51) —
  roughly 50 seconds off the run.
- **The "contact created, pass failed" stranded state disappears for new
  students.** §12 of the design spec exists to handle a student who has a
  contact record but no pass, created by a run that died between two writes.
  For a *new* student that gap is now unreachable: the contact and the pass are
  one request, and it either happened or it did not.
- **Nothing is given up.** Same start date, same expiry, same access.

**The two-call route stays in the code, for existing contacts.** A student the
matcher *finds* already in Clubworx cannot be re-created, so a found contact
lacking an active pass still needs `POST /memberships`. Both paths are now
measured; neither is speculative.

## Still open

- **Form-encoded `POST /members` is untested.** JSON worked first and the probe
  reuses its contacts, so proving the form shape would cost another permanent
  contact. JSON is what the Worker should send.
- **Whether the two-call route can set a *future* `start_date` is unproven.**
  Both #60 and this probe sent *today's* date — which is also Clubworx's
  default — so no run has yet distinguished "Clubworx honoured what we sent"
  from "Clubworx ignored it and used today". D's `honouredRequest: true` is
  therefore not evidence of control. It does not matter for #46, which always
  wants a pass active now, but nothing should be built on the assumption that a
  future start date is expressible.
- **Whether `spaces_available` refuses at the cap** — still
  [#75](https://github.com/urbanjungleirc/staff-site/issues/75), untouched here.
  Only one booking at a time was made against 25 spaces.
- **What a term's worth of school members does to Clubworx reporting.** Open on
  #46, unchanged.

## How it was run

```bash
node probes/run-63.mjs --dry-run                 # the plan and every request, zero network
node probes/run-63.mjs                           # read-only: what exists, and the plan lookup
node probes/run-63.mjs --event=20481679 --write  # the run above
```

23 reads and 6 writes, paced at one per 800ms (~75/min) per #51.

The probe **searches all three status views before every verdict** and before
every create, so a re-run costs nothing permanent — verified: a second read-only
run reported `SKIPPED — already exists` for both contacts and `SKIPPED — an
active pass is already held` for D's pass.

Two gates keep the permanence proportionate. **E is only attempted if D is seen
to exist**, so an endpoint that refused would have cost one contact rather than
two. And **`--write` without `--event=<id>` refuses to start**: questions 1, 3
and 4 need no event, so without that gate a run could spend two permanent
contacts and two permanent passes and still leave question 2 — the one that
decides whether any of it is usable — unanswered.

## Cleanup

Both bookings were cancelled by the probe and the re-counts confirmed it —
nothing is outstanding on the event.

**Permanent, and recorded in ACCESS.md §4:**

| | Record | Id | Note |
|---|---|---|---|
| D | contact `Ztest Wayfinderfour` | `5a7f1d25-7964-4f42-bbc2-1ec93e7f7aeb` | in `/members` |
| E | contact `Ztest Wayfinderfive` | `676df583-e637-42e6-9fee-38631461baad` | in `/members` |
| D | School Pass | `2629905` | 2026-08-20 → 2026-11-11 |
| E | School Pass | `2629906` | 2026-08-20 → 2026-11-11, granted by the create |

Contacts have no delete endpoint and must be removed by hand in the Clubworx UI.
Memberships have none either; both passes lapse on 2026-11-11 by themselves.

Still owed a manual deletion, unchanged by this probe: the three `Ztest`
contacts from [#49](49-plus-addressed-duplicates.md), the School Pass #60 left
on `Ztest Wayfinder`, and the test event `20481679` once it is finished with.
