# Plus-addressed duplicate emails on `noreply@` — the answer to #49

Probed against production Clubworx on **2026-08-17**. Three contacts created,
all permanent; the cleanup list is at the bottom.

**The school-marking scheme survives.** Every assumption #46 took on inference
from reads held up against a write. Plus-addressing is accepted, email is not
unique per contact, and a full tag isolates its own contacts cleanly.

One thing did *not* get answered, and it is not the one that was expected — see
[What is still unproven](#what-is-still-unproven).

## The four questions

### 1. Does `POST /api/v2/prospects` accept a plus-addressed `noreply@`? — **Yes**

`noreply+wayfindertest@urbanjungleirc.com` was accepted with no validation
complaint about the `+`.

Clubworx also does not normalise the tag away, which is what makes it usable as
a provenance marker at all — but the evidence for that is the **exact-match
search**, not the create response. A later `GET ?email=noreply+wayfindertest@…`
returned precisely the two contacts written on that address, which it could not
do if the stored value differed from the one sent. The create response was never
inspected for its `email` field; the probe now records it (`emailEcho`) so a
future run has the direct measurement rather than this inference.

**It answers `200`, not `201`.** A client that treats "created" as `201` will
read every successful write as a failure. Check `2xx`, not the exact code.

### 2. Can many contacts share one email? — **Yes**

Contact B was created with **byte-identical** email to contact A and a different
surname. It was accepted, and given its own `contact_key`:

| | Surname | Email | `contact_key` |
|---|---|---|---|
| A | `Wayfinder` | `noreply+wayfindertest@…` | `e35218ef…e574f` |
| B | `Wayfindertwo` | `noreply+wayfindertest@…` | `298dab8a…8f2e1` |

Email is **not** unique per contact. This is the finding the parked design
depended on and had only inferred — siblings sharing a parent's address are a
real case, and it now has a write behind it rather than an assumption.

The fallback #49 named — a dedicated prospect status, which loses the
which-school record — is **not needed**.

### 3. Does the marker find its contacts, and only its contacts? — **Yes, both**

On `/prospects`, with three contacts across two tags:

| Query | Returned | Verdict |
|---|---|---|
| `email=noreply%2B` (partial) | 3 of 3 | partial match works |
| `email=noreply+wayfindertest@…` | exactly A and B | isolated |
| `email=noreply+wayfindertestb@…` | exactly C | isolated |

No cross-tag leakage in either direction, and nothing missing. `email` is a
prefix/partial match, so `noreply%2B` acts as "every school-created contact" and
a full address acts as "this school only". Both halves the design needs.

### 4. Does the same hold on `/members` and `/non_attending_contacts`? — **Not applicable, and that is the finding**

Every query against both returned **HTTP 200 with zero rows** — including the
bare `noreply%2B` partial.

This is not the email filter failing. A contact created through
`POST /prospects` exists **only** as a prospect: the three endpoints are
disjoint views by contact status, not three indexes over one table. Nothing was
there to find.

**Consequence for #46's dedup pass:** searching `/prospects` alone is not
enough, and neither is picking one endpoint by guesswork. Which endpoint holds a
given student depends on their *current status* — a student who later takes a
membership moves out of `/prospects` — so a lookup has to search all three and
merge. That was already the plan; it is now a requirement with a reason.

## What is still unproven

**The email filter's behaviour on `/members` and `/non_attending_contacts` was
never exercised.** Those endpoints returned zero rows because they held none of
the probe's contacts, so the filter was never given a matching row to return.
"Zero results" is consistent with a working filter *and* with one that ignores
the `email` parameter entirely.

This matters because #46's dedup pass relies on that filter on all three
endpoints. Proving it needs a contact that is actually a member — which this
probe cannot create, and which #50 may be able to arrange. Recorded as a gap
rather than smoothed into the "yes" above.

**So #49 closes on three and a half of its four questions.** Questions 1–3 are
answered against writes. Question 4 is answered only in the sense that the
endpoints were shown to be disjoint by status; the email filter on two of them
remains unexercised. Whether that is enough to close the ticket is the issue
owner's call, not the probe's.

Also untested: pagination. Three contacts is far inside the default
`page_size` of 50, so nothing here says how a school with 63 students on one
`noreply+` tag pages — and #48 found a real list of exactly that size. The
`page_size` cap from #51 applies, but the interaction with an email filter is
unmeasured.

## Fields a contact comes back with

Schema only, no values:

```
first_name  last_name  email  phone  status  dob  address
contact_key  last_attended  source  created_on  created
```

`source` and `status` are both present, which is worth noting for #52: they are
alternative provenance carriers if the `noreply+` marker ever has to be dropped.

## How it was run

```bash
node probes/run-49.mjs --dry-run   # the plan, zero requests
node probes/run-49.mjs             # read-only: search, then the isolation reads
node probes/run-49.mjs --write     # the only mode that creates anything
```

18 requests for the full write run, paced at one per 800ms (~75/min) per #51.
The probe **searches first** and reuses what it finds, so re-running it costs
nothing permanent — verified: a second run reported `still to create: none` and
made 0 writes.

Two controls sit in front of every write, in `lib/write.mjs` and
`lib/identity.mjs`: writing is off unless explicitly enabled, and every contact
must pass an identity guard before the network is touched. A write under
anything resembling a real name is refused rather than reported afterwards —
which matters, because it cannot be undone.

## ⚠️ Cleanup — delete these by hand

Clubworx cannot delete contacts through the API (ACCESS.md §4). These three are
permanent until someone removes them in the Clubworx UI. They sort to the end of
an alphabetical list under `Ztest`.

| | Name | Email | `contact_key` |
|---|---|---|---|
| A | `Ztest Wayfinder` | `noreply+wayfindertest@urbanjungleirc.com` | `e35218ef-4e96-4928-a05f-1c14f56e574f` |
| B | `Ztest Wayfindertwo` | `noreply+wayfindertest@urbanjungleirc.com` | `298dab8a-22b5-41f1-87b9-3936172f8ee1` |
| C | `Ztest Wayfinderthree` | `noreply+wayfindertestb@urbanjungleirc.com` | `b39b1560-e76d-45bc-9f67-d19a1fbcb873` |

**#50 should reuse these rather than create its own.** They are already the
membership-less prospects that ticket needs, and every extra contact is another
row somebody has to delete by hand.
