# The member + School Pass route — the answer to #60

Probed against production Clubworx on **2026-08-18**, into a purpose-made
School Session (`20481679`, "test school booking"). Successor to
[#50](50-membership-less-booking.md), which showed the prospect route does not
work.

**The route works.** A member holding an active School Pass books into a School
Session, the server refuses a duplicate by itself, and the booking can be
undone. Every assumption #46 was about to design against is now measured.

| | Question | Answer |
|---|---|---|
| 1 | Does `POST /memberships` work, and is the pass active at once? | **Yes** |
| 2 | Can the plan be resolved by name? | **Yes — but not on the default page** |
| 3 | Does a member with an active School Pass book? | **Yes**, HTTP 200 |
| 4 | Does `spaces_available` predict bookability? | **Consistent, but not proven at the cap** |
| 5 | What does the 1-day-ahead rule return? | `400 "this class is now closed for bookings"` |
| 6 | Does booking twice duplicate? | **No — the server refuses it** |
| 7 | Does `DELETE /bookings/:id` reverse a booking? | **Yes**, verified by re-count |

Nothing was left behind: the booking was created and then cancelled. One
permanent record was added, the School Pass itself — see [Cleanup](#cleanup).

## 1. Assigning the pass

`POST /api/v2/memberships`, **form-encoded**, with `account_key`, `contact_key`,
`membership_plan_id` and `start_date`. Answered **HTTP 200**, and the pass was
held and active on the next read:

```
id 2627746 · membership_plan_id 64189 · name "School Pass"
start_date 2026-08-18 · expiration_date 2026-11-09
class_access "Unlimited classes" · upfront_charge null · recurring_charge null
classes_booked 0 · classes_attended 0 · classes_remaining null
```

`expiration_date` is **exactly the 12 weeks** the plan is configured for, so the
tool never computes an expiry — it sends `start_date` and reads the end date
back. That matters for the term-coverage requirement: the answer comes from
Clubworx rather than from arithmetic that could drift from the plan.

### There is no `status` field

A membership record carries `start_date` and `expiration_date` and **nothing
that says "active"**. Anything checking `status` gets `undefined`, and a live
pass reads as inactive. Activity is derived from the two dates, inclusive at
both ends — `summariseMemberships` does this, and distinguishes *holding the
plan* from *holding an active one*, because an expired pass is still a returned
row.

## 2. Resolving the plan by name — and the trap under it

The tool turns the plan **name** into a `membership_plan_id`, because a
hard-coded id is a number nobody can check against the Clubworx UI.

`GET /api/v2/membership_plans` returned **exactly 50** plans. UJ has **57**, and
`School Pass` was among the seven that never arrived.

This is [#51](51-events-and-burst.md)'s silent truncation — a full page is
indistinguishable from a complete list, with no total, no next-page link and no
header — landing in the one place where the answer decides whether anything can
be booked at all. **A lookup on the default page reports "no such plan" and the
whole run stops**, for a plan that plainly exists.

Two rules follow, both implemented in `findPlanByName`:

- Always request a `page_size` past the default, and **treat a full page as
  truncated** rather than as an answer.
- **Refuse an ambiguous name.** Two plans sharing a name is an error, not a
  first-wins: assigning the wrong plan is permanent.

Resolved: `id 64189`, `membership_duration "12 weeks"`, `upfront_payment_amount
"0.0"`, no recurring charge — so a School Pass costs nothing and starts no
billing schedule.

## 3, 6, 7. Booking, double-booking, and undo

Against the event moved to **2026-08-21 12:00 (+08:00)**, 68.4 hours ahead:

| Step | Result | Bookings held |
|---|---|---|
| Before | — | 0 |
| `POST /bookings` | **200 created**, booking `63510241` | 1 |
| `POST /bookings` again | **400** `"Woops! You've already booked into this class!"` | 1 |
| `DELETE /bookings/63510241` | **200** | **0** |

### The server refuses duplicates itself

This was the load-bearing unknown. Re-running the tool against an event
**cannot** double-book a student: the second attempt is rejected outright, and
the count confirms it — 1 before, 1 after. Judged on the re-count rather than on
the status, because an accepted-but-silent duplicate would look identical to an
idempotent server from the response alone.

So a failed run is safely retryable on the booking half.

### `DELETE` works, and #50's finding is now properly retired

The booking left the contact's list — verified by re-reading, not assumed from
the 200. [#50](50-membership-less-booking.md) reported that bookings could not
be deleted at all, on the strength of a `401 "Authorization failed"`. That was a
malformed request: **`DELETE /api/v2/bookings/:id` requires `contact_key` as
well as `account_key`, form-encoded in the body.** Sent correctly, it reverses
cleanly.

`lib/booking.mjs` takes the contact from the booking record rather than from the
caller, so it cannot be omitted or mismatched.

## 5. The lead-time rule, and the error vocabulary

The same event, same contact, same pass, at two distances:

| Event starts | Result |
|---|---|
| 20.6h ahead | **400** `"Sorry! This class is now closed for bookings."` |
| 68.4h ahead | **200 created** |

The one-day minimum is real and enforced server-side. The tool should refuse
anything inside it *before* writing, because the message a staff member would
otherwise see says nothing about lead time.

**Three distinct refusals now have known text**, and #53's failure model can
tell them apart:

| Message | Means |
|---|---|
| `"Sorry, this class has no free spaces available."` | the contact is a **prospect** hitting its allowance (#50) — *not* capacity |
| `"Sorry! This class is now closed for bookings."` | inside the **lead time** |
| `"Woops! You've already booked into this class!"` | **already booked** — safe, and the idempotency guarantee |

None of them is machine-readable beyond the string. They arrive as
`{"error": "..."}` with HTTP 400 in every case, so the status alone cannot
distinguish a retryable problem from a permanent one.

## 4. What `spaces_available` still does not prove

It reported **25 free**, `event_full: false`, and the booking succeeded — so it
was *consistent* here, where in #50 it was actively misleading.

But only **one** booking was made against 25 spaces. Whether the number
decrements, and whether it correctly refuses at the cap now that the event
restricts to School Pass holders, is **unmeasured**. #46's picker plans to warn
staff — "30 students, 12 spaces" — from exactly this field, so it is worth one
more probe before that warning is trusted.

## What this settles for #46

- The **member + School Pass route is viable**, and is no longer a proposal.
- **Booking is idempotent**, so a partial run can be re-run without
  double-booking anyone.
- **Bookings can be undone**; contacts and memberships cannot. That is the real
  undo asymmetry for #53, and it is narrower than feared — but it is still an
  asymmetry, and the UI must not imply that undo restores the prior state.
- A School Pass **costs nothing** and starts no billing schedule, which removes
  the cost question #50 raised about the new route.

## Still open

- Whether `spaces_available` blocks at the cap (question 4, above).
- Whether a membership can be **removed**. No delete appears in the reference,
  and none was attempted. An expired pass simply lapses.
- Whether assigning a **second** School Pass to someone who already holds one
  duplicates it. The probe reuses an active pass rather than testing this, on
  purpose — memberships have no delete.
- What a term's worth of school members does to Clubworx **reporting**. Open on
  #46, unchanged by this probe.

## How it was run

```bash
node probes/run-60.mjs --dry-run                 # the plan and every request, zero network
node probes/run-60.mjs                           # read-only: contacts, plan, memberships, event
node probes/run-60.mjs --event=20481679 --write  # the run above
```

13 reads and 3 writes, paced at one per 800ms (~75/min) per #51.

The probe **creates no contacts** — ACCESS.md §4's authorisation is spent — and
searches before both writes, so a re-run costs nothing permanent. It reuses an
*active* pass rather than any pass: an expired one would leave the booking to
fail for a reason already visible in the read.

The contacts were converted from prospects to **members** by hand before this
run. That broke `run-50.mjs`, which searched `/prospects` only; #49 had already
established the three endpoints are disjoint views by status. `run-60.mjs`
searches all three. **The real tool has the same exposure**: a student who takes
a membership later moves out of `/prospects`, and a prospect-only lookup would
silently stop finding them.

## Cleanup

The booking was cancelled by the probe — nothing is outstanding on the event.

**Permanent:** School Pass `2627746` on `Ztest Wayfinder`
(`e35218ef-4e96-4928-a05f-1c14f56e574f`), expiring 2026-11-09. Memberships have
no delete endpoint; it will lapse on its own.

The three `Ztest` contacts from [#49](49-plus-addressed-duplicates.md) remain
permanent and are still owed a manual deletion in the Clubworx UI, along with
the test event `20481679` once it is finished with.
