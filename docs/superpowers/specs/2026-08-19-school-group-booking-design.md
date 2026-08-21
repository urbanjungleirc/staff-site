# School group booking from a pasted student list

**Date:** 2026-08-19
**Repo:** `urbanjungleirc/staff-site` (`uj/staff-portal`)
**Files:** `school-booking.html`, `school-booking/*.js`, `cloudflare-clubworx/`
**Status:** Approved. Ready to build.
**Wayfinding map:** [#46](https://github.com/urbanjungleirc/staff-site/issues/46) — charted across #47–#54, closed by #55.

Staff run climbing sessions for school groups. The school sends a participant
list; today a staff member types each student into Clubworx by hand and then
books them into each session one at a time. A 63-student list across six
sessions is several hours of clicking, and every mistake in it is permanent.

This spec describes a staff-portal page that takes the pasted list and does it
in about four minutes.

> **Every claim here about Clubworx behaviour was measured**, in
> `cloudflare-clubworx/probes/`, against production, on 2026-08-17/18 and
> 2026-08-20 (#63, the member-creation gate). Where something is inferred from
> the reference rather than observed, it says so.
> The reference has been wrong twice on this effort — see
> [Two things the reference got wrong](#two-things-the-reference-got-wrong) —
> so the distinction is not pedantry.

---

## 1. The premise, and why this is buildable when #45 was not

[staff-site#45](https://github.com/urbanjungleirc/staff-site/issues/45) — a
general participant matcher — is parked, and stays parked. The Clubworx API
exposes no waiver or pending-review data, so a participant with no contact
record is indistinguishable from one who signed a waiver last week and is
sitting unreviewed in the queue. Creating a contact for them produces a
duplicate that cannot be deleted.

School sessions escape that entirely, for two reasons:

- **The school carries consent.** No student waiver ever enters Pending
  Reviews, so there is no pending record for a created contact to collide with.
- **School lists carry DOB.** #45's name-only lists had no real matching key.
  Surname + DOB is one.

**Accepted long-tail.** A student who later returns *privately* and signs a
waiver then will produce a second contact. That is the same exposure as any
prospect UJ staff create by hand today — this system does not introduce it, and
the API offers no merge operation to fix it either way.

---

## 2. The route a student takes

**A student is created as a member, given a School Pass, and booked into a
School Session.**

```
paste ──► parse ──► match against Clubworx
                          │
                          ├─ found  ──► (re-read membership) ──► ensure School Pass ──► book ×N
                          └─ new    ──► create contact WITH the pass ─────────────────► book ×N
```

A **found** student needs the pass assigned separately; a **new** one gets it in
the create call. Both measured — see below.

### Why the original prospect route failed

This map was charted around creating each student as a **prospect**. #50 proved
that does not work.

`POST /bookings` for a membership-less prospect is refused
`400 "Sorry, this class has no free spaces available."` — on an event reporting
**25 spaces free** and `event_full: false`. The real mechanism is a **per-contact
prospect allowance**: the Clubworx UI warns that the prospect has already booked
once and offers a human an override, and **the API offers none**. No field on
`/events` exposes it.

Two consequences outlived the route change:

1. **`spaces_available` does not predict bookability.** It has been actively
   misleading once. It is used for a warning in this design and for nothing else.
2. **An error message can point confidently at the wrong mechanism.** This is
   why §11 never paraphrases an unrecognised refusal.

### The replacement, measured end to end in #60 and #63

| Step | Call | Status |
|---|---|---|
| Create contact | `POST /api/v2/members` | **Measured (#63).** **JSON**, with `account_key` in the query string. **200**; lands straight in `/members`. Takes `membership_plan_id`, so the next row is optional for new students |
| Assign pass | `POST /api/v2/memberships` | **Measured.** Form-encoded, with `account_key`, `contact_key`, `membership_plan_id`, `start_date`. **200**; active immediately. Needed only for contacts that **already existed** — see below |
| Book | `POST /api/v2/bookings` | **Measured.** **200**; a second identical call is refused by Clubworx itself |
| Unbook | `DELETE /api/v2/bookings/:id` | **Measured.** **200**; needs **`contact_key` as well as `account_key`, form-encoded in the body** |

### Creating a member — measured, and the one-call route is adopted

[#63](https://github.com/urbanjungleirc/staff-site/issues/63) ran this against
production on 2026-08-20. Full evidence:
`cloudflare-clubworx/probes/63-member-creation.md`.

**`POST /api/v2/members` works, and the pass rides along.** So a **new** student
is created and given their School Pass in **one** request:

```
POST /api/v2/members    first_name, last_name, email, dob, membership_plan_id
                        JSON body, account_key in the query string
                        -> 200, contact created, pass active from today
```

| What was unknown | What was measured |
|---|---|
| Does `POST /members` succeed? | **Yes** — HTTP **200**, not `201` |
| Which body shape? | **JSON**. See the warning below |
| Is the contact bookable? | **Yes** — booked and cancelled cleanly, both routes |
| Does `membership_plan_id` work on create? | **Yes** — exactly one pass, active on the next read |
| What `start_date` does it get? | **The creation day** — the same date the two-call route was sending |

**The trade-off this section was braced for does not exist.** The one-call pass
and the two-call pass came back identical — same `start_date` (2026-08-20), same
`expiration_date` (2026-11-11), same `class_access`. Nothing is given up by
letting Clubworx choose, because it chooses today.

**The two-call route stays, for contacts that already exist.** A student the
matcher *finds* cannot be re-created, so a found contact without an active pass
still needs `POST /memberships` (§2's `found` branch). Both paths are measured.

**Consequence for §12:** the "contact created, pass failed" stranded state is
now unreachable **for new students** — the contact and the pass are one request,
which either happened or did not. §12 still handles it for found contacts.

> ⚠️ **Send JSON, not form-encoded.** The reference calls this endpoint
> form-encoded. #63 tried JSON first — the only contact-create shape ever
> measured here (#49) — and it answered 200 on the first attempt, so **the
> form-encoded shape was never tested** and cannot now be tested without
> creating another permanent contact. JSON is what is measured; do not "correct"
> it to form-encoding on the strength of the reference alone.
>
> To be fair to the reference: on this endpoint it was **right**. It said
> `membership_plan_id` works on create, and it does. The encoding is the one
> claim #63 could not check, because the first shape it tried succeeded.
>
> Note the sibling write paths differ: **`/memberships` is form-encoded** (#60).
> The encoding is per-endpoint, not per-API.
>
> **Corrected 2026-08-20, while building #69.** This line previously said
> `/bookings` was form-encoded too. It is not: `probes/lib/booking.mjs` sent a
> **JSON** body and that is the call that produced the 200 creating booking
> `63510241` in #60. The reversal — `DELETE /bookings/:id` — *is* form-encoded,
> and that is almost certainly where the mistake came from. The Worker
> implements what was run: JSON to `POST /members` and `POST /bookings`, a form
> to `POST /memberships` and `DELETE /bookings/:id`. Anyone reconciling the two
> should trust `probes/lib/` over this table — it is the code that was executed.

**A created member holds no membership until one is granted.** #63 found D
sitting in `GET /members` with an empty `/memberships` list. This section
previously reasoned that assigning a pass is what *moves* a contact into
`/members`; that is not the mechanism. **The status view is set by the endpoint
that created the contact.** The conclusion was right and is now better — no move
is needed, because the contact starts where it belongs.

**A School Pass costs nothing** — `upfront_payment_amount "0.0"`, no recurring
charge — and starts no billing schedule.

**`expiration_date` comes back as exactly the plan's configured duration** — 12
weeks when #60 and #63 measured it, **26 weeks since 2026-08-20** (§3, ADR 0005).
The tool sends a `start_date` and *reads* the end date. It never computes an
expiry, so nothing here can drift from the plan's configuration, and the
duration change needed no code.

**A membership has no `status` field.** Whether a pass is active is derived from
`start_date`/`expiration_date`, inclusive at both ends. Code that looks for
`status` reads `undefined` and treats a live pass as inactive.

---

## 3. The naming decisions

Clubworx event type **`School Session`**; membership plan **`School Pass`**.

Deliberately different nouns. A *session* happens on a date; a *pass* is held by
a person. The pair was otherwise easy to confuse in a dropdown or a sentence,
and they mean genuinely different things — the session admits pass-holders, the
pass is what makes a person admissible.

**The plan name is never renamed per student, per school, or per term.**
Reporting aggregates by plan, so per-student plan names would fragment member
counts and revenue into 63 one-member plans. School provenance already travels
in the `noreply+<school>@` marker (§4), and the term is implied by the
membership's `start_date`.

Duration stays out of the name because `GET /membership_plans` already exposes
`membership_duration`.

**The pass runs 26 weeks** — long enough to cover a UJ term including its
snapped edges ([ADR 0002](../../adr/0002-uj-term-weeks-are-snapped.md)) *and*
the lead time a school booking is made with. It ran 12 weeks until 2026-08-20;
why it does not any more is the next section, and the decision is
[ADR 0005](../../adr/0005-school-pass-runs-26-weeks.md).

### Why the pass is 26 weeks and not 12

> **Raised 2026-08-20, after the spec was written.** The 12 weeks were sized
> against the *term*, and silently assumed the booking is made at the start of
> it. School bookings are not always made that way: a school can send its list
> and have staff book the whole term **three or four weeks before the first
> session**. This is unlikely but real, and it is the one case the duration
> was never checked against.

The pass runs from its `start_date` for **84 days of access** (#63 measured
83 days of difference, inclusive at both ends). A ten-session weekly term spans
**63 days** — first session day 0, tenth session day 63. Under the adopted
route the pass starts on the **creation day**, which is the day staff run the
tool, so:

```
lead time L  →  last session lands on day L + 63
pass covers  →  days 0 … 83
safe while   →  L ≤ 20 days
```

A run made **three weeks ahead loses the last session; four weeks ahead loses
the last two.** Nothing in the tool would notice: every booking is written on
the day of the run, when the pass is unambiguously active.

**Whether that actually costs anything was unmeasured when the fix below was
adopted** — and the fix deliberately did not wait to find out, because it holds
either way. Three possibilities were on the table:

- If Clubworx checks the pass **only at booking time**, a pass expiring before
  session ten is irrelevant — the booking already exists, and attendance is a
  property of the booking. Nothing needs changing.
- If it checks the pass **against the session date**, the far-ahead bookings are
  refused at write time, and the run visibly fails on the tail sessions.
- If it checks **both**, then a future `start_date` cannot be the fix — the pass
  would not be active when the booking is written — and the only lever left is
  the plan's **duration**.

> **Settled 2026-08-21: it is both.** Confirmed by Jiri from Clubworx's own
> behaviour rather than by an API probe ([#90](https://github.com/urbanjungleirc/staff-site/issues/90)) —
> a booking is refused when the session falls **past the pass's expiry**, and
> refused again when it falls **before the pass is active**.
>
> Three things follow. **The 26 weeks were necessary, not merely safe** — the
> tail sessions of a far-ahead term really would have been refused. **A future
> `start_date` is positively ruled out**, not just unproven. And **the coverage
> checks below are load-bearing**: they are what stops a run part-way instead of
> stranding a student who has been created, passed, and half-booked.
>
> One thing is still unrecorded: **the refusal's message string.** §11's error
> vocabulary discriminates Clubworx's 400s by their text, and this is a fourth
> refusal nobody has captured. It fails safe — an unmatched 400 is `unknown`,
> shown verbatim, and three consecutive failures halt the run — but it will read
> as `unknown` on screen until someone records it.

Three fixes were considered. **The plan is lengthened to 26 weeks** — decided
2026-08-20, recorded in [ADR 0005](../../adr/0005-school-pass-runs-26-weeks.md).

| Fix | Verdict |
|---|---|
| **Lengthen the plan** in Clubworx to **26 weeks** | **Adopted, and applied in Clubworx 2026-08-21.** Config only — no code, no date arithmetic, and it holds under all three checking models above, so it did not wait on #90. Now known to have been the *only* available lever |
| **Start the pass at the first selected session** | Rejected. Gives up the one-call create for any far-ahead run, since `POST /members` starts the pass *today* (#63); the write chain would need session dates it does not receive; and it rests on a future `start_date` being honoured, which is **unproven** — flagged in #63 — *and* on session-date checking, which is unmeasured. Two unknowns to buy what a config change buys outright |
| **Refuse the run** when the last selected session falls outside the pass | **Kept, but as a guard rather than a fix.** It solves nothing alone — it makes the failure visible instead of silent — and it is the thing that stops this hole reopening quietly. See below |

**26 weeks is 182 days of access.** A 63-day term therefore stays covered with
**up to 118 days — just under 17 weeks — of lead time**, which is past any
plausible school booking. The pass costs nothing and starts no billing schedule
(#60), so the duration is free in money.

**What it is not free of** is §15's open reporting question, and this decision
makes it bigger rather than smaller: a term's intake now reads as **current
members for six months** rather than three, and the lapse lands mid-following-term
rather than at the end of the one they attended.

### The guard that keeps this from reopening

The duration lives in Clubworx, where it can be edited by anyone, and the tool
reads it rather than owning it. So the tool checks coverage rather than trusting
the number:

- **Before any write** — the last selected session must fall within
  `today + membership_duration`. `GET /membership_plans` returns
  `membership_duration` as a **human string** (`"12 weeks"`, `"6 weeks"`), so
  this parse is best-effort: if it cannot be read, say so on screen rather than
  skipping the check silently.
- **For a found student** — compare the held pass's **`expiration_date`** against
  the last selected session. No parsing, no assumption: the field is exact.
  *This is the check that matters, and it is not solved by the 26 weeks* — see
  below.
- **The number 26 appears nowhere in the code.** A pass whose duration is later
  shortened produces a visible refusal, not a silent tail of missing bookings.

### 26 weeks makes the *found* branch harder, not easier

Under a 12-week pass a returning student's old School Pass had usually expired,
so §2's `found` branch simply granted a new one. At 26 weeks it will far more
often find a pass that is **active today but expires mid-term** — the band where
the old pass covers session one and not session ten.

`ensure School Pass` therefore cannot mean *active today*. It means **covers the
last selected session** — and since 2026-08-21 that is a measured requirement
rather than a precaution, because the session date is checked. That is what
makes the never-probed question — whether a second School Pass on an active
holder duplicates it — start to matter, where D4 previously closed it for free.

**It is now the only open question left on the pass.** #90's first question is
answered; its second — the irreversible one, which spends a permanent membership
on a permanent contact to learn the answer — is deliberately not run. Until it
is, a returning student holding a live-but-not-covering pass is a
`needs-confirmation` row, resolved by a human, never a silent second grant.

### Why there is no event-naming convention

`GET /events` exposes **no event-type field** — verified against production and
against the reference. The API therefore *cannot* tell the tool which events are
School Sessions, and no naming convention would change that, because nothing
machine-readable would enforce it.

That is survivable, and the reason is worth stating because it looks like a gap:

- Staff pick the event by hand from a searchable list, and existing event names
  already carry the school's name.
- **A wrong pick fails safely.** A School Pass does not entitle a general class,
  so every booking into a non-School-Session event is refused outright. There is
  no half-succeeding case where 20 students land in the wrong class.

---

## 4. School marking

Every contact this tool creates is written with the email
**`noreply+<school>@urbanjungleirc.com`**.

One field carrying three things: a marker that this is a school-import contact,
a record of *which* school, and a search key — Clubworx's email filter
partial-matches, so `noreply%2B` finds every contact the tool has ever created
and a full tag isolates one school's.

Measured in #49: `POST` accepts the plus-addressed form and stores the tag
**unchanged**, and **email is not unique per contact** — so siblings sharing an
address is a working case, not a collision, and the dedicated-status fallback
that was held in reserve is not needed.

**The `<school>` slug is chosen by staff, never parsed from the paste.** Staff
pick from schools already in Clubworx (found by the `noreply%2B` search) or type
a new one. This marker is the only provenance this system will ever have — see
§6 on why — and it is permanent and searchable. Deriving it from the least
reliable line in a pasted document is not a trade worth making.

It also settles that the title line of a paste is **junk, not data** (§7, P9).

---

## 5. Identity and matching

**Surname + DOB narrows; first name breaks ties.**

- Search **all three contact status endpoints** — `/prospects`, `/members`,
  `/non_attending_contacts`. These are three **disjoint views by status**, not
  three indexes over one table (#49), and a contact moves between them as their
  status changes. A prospect-only lookup silently stops finding a student the
  moment they take a membership. This broke the #50 probe in practice when its
  test contacts were converted, and the real dedup pass has exactly the same
  exposure.
- **Surname + DOB** is the candidate query. **First name** breaks ties — twins
  share both surname and birthday.
- **First-name variance is surfaced, never auto-merged.** Katie/Katherine is a
  human decision. So is the `PreferredName` case (§7): a first-name mismatch can
  be the *correct* outcome of a correct match.
- A contact is created only when the student appears in **none** of the three.

Matching runs on **compare form**, never write form — see §7 P10. That is what
lets `O'Brien` match `OBrien` without ever writing the second spelling into a
record that cannot be deleted.

---

## 6. Architecture and auth

### Why the account key cannot live in the page

**staff-site is a public repo**, and `.github/workflows/pages.yml` rsyncs the
whole tree into the published site. Anything in the page is world-readable, in
git history, permanently.

Worse, **Clubworx issues exactly one key per gym** (#47). There is no
per-integration key. So the key in this page would be the key that reads and
writes UJ's entire ~60,000-profile contact database, shared with the HVT Worker
and every n8n workflow. A leak from here is a leak of all of it.

**The browser talks to the Worker; only the Worker talks to Clubworx.**

### The Worker

A new Worker at `cloudflare-clubworx/`, deployed from the UJ Cloudflare account,
routed at `ujstaff.happyk.au/api/clubworx/*`.

- `CLUBWORX_ACCOUNT_KEY` is a **Wrangler secret** (`npx wrangler secret put`),
  never `[vars]` in the committed `wrangler.toml`. Locally it lives in
  gitignored `cloudflare-clubworx/.dev.vars` — see `ACCESS.md`.
- **Auth is Cloudflare Access**, as with the voucher proxy. Access runs in front
  of Workers routes on this zone and injects a signed `Cf-Access-Jwt-Assertion`.
  The Worker **verifies the signature** against the `happyk.cloudflareaccess.com`
  JWKS rather than trusting the header's presence, and fails **closed**.
- The verified email is attached to every write in the Worker's own log line.
  Whether a narrower allowlist is warranted — as the voucher hard-delete has —
  is an open question (§15); recording the email now is what will let that be
  decided on evidence rather than on feel.

### The Worker stores nothing

**No student name or date of birth is written to any Cloudflare store, KV, D1,
or log.** The Worker is a transit, not a database (D10). Two rules enforce it:

- No run store, no run identity, no persistence of any kind.
- **Request and response bodies are never logged.** Observability logs the
  route, the status, the operator email and the timing — never the payload.
  This is easy to break by adding one debugging `console.log(body)`.

### Routes

| Route | Does |
|---|---|
| `GET /api/clubworx/events?from=&to=&q=` | Lists events in a date window, paged to exhaustion |
| `GET /api/clubworx/plan?name=School+Pass` | Resolves the plan name to an id (§13) |
| `GET /api/clubworx/schools` | Distinct `noreply+<tag>@` values, for the school picker |
| `GET /api/clubworx/contacts?last_name=&dob=` | Searches all three status views and merges |
| `POST /api/clubworx/student` | **The unit of work.** One student's whole write chain (§10) |
| `POST /api/clubworx/unbook` | `DELETE /bookings/:id` with `contact_key` (§12) |

### Reuse what the probes already proved

`cloudflare-clubworx/probes/lib/` holds pure, vitest-tested modules written
against measured behaviour. These are **promoted into the Worker's own module,
not re-implemented**:

| From `probes/lib/` | Why it matters |
|---|---|
| `findPlanByName` | Carries the page-size truncation guard and the ambiguity refusal (§13) |
| `summariseMemberships` | Derives "active" from the two dates, since there is no `status` |
| `describeLeadTime` | The 24-hour rule (§13) |
| `pickBookableEvents` | Event filtering with the lead time applied |
| `errorMessageOf` | Extracts `{"error": "..."}` safely, including the non-JSON case |
| `buildUrl`, `redact` | Request construction, and keeping the key out of anything printed |

Re-deriving these would re-derive their bugs. Each already has a test file
beside it.

### Pacing

**75 requests per minute, one in flight** — measured in #51: ~50 fast requests,
then ~18 s of `429`. Clubworx advertises **no rate-limit headers at all**, so a
client cannot self-throttle from response metadata; the pace is a design
constant, not an adaptive one. Concurrency is the wrong lever.

The whole pipeline is strictly serial — the browser sends one student at a time
and waits, and the Worker paces its own calls at ~800 ms — so the aggregate rate
never exceeds the ceiling without any global governor.

**The allowance is gym-wide.** The roster Worker and n8n spend it unseen, which
is why a `429` is retried (§11) and why the message says so out loud.

### What a run costs

Per student: 3 dedup reads + 1 membership read (matched students only) + contact
write + membership write + one booking per event.

**25 students × 6 events ≈ 300 requests ≈ 4 minutes.** A re-run where nothing
needs doing still costs ~250. That is roughly 6× the measured burst allowance,
so a school import is a four-minute gym-wide slowdown and "just re-run it" is
not free. Several decisions below turn on that number.

---

## 7. Parsing rules

Settled on #52 against the three real lists catalogued in #48. The full
reasoning is on that ticket; what follows is the rule set.

> **Why none of this is cosmetic.** Under the member + School Pass route a
> student is three writes, and only the last is reversible. A parsing misread
> creates a **permanent wrong contact with a permanent membership on it**.

### Framing

**P1 — The parser may never *drop* a line, only classify it.** Every input line
lands in exactly one bucket — record, ignored-junk, or error — and
`records + ignored + errors == input line count`. This is an assertion a test
can make, and the rest of the rules lean on it.

**P2 — It emits rows, per-row parse state, *and* list-level inferences**:
detected layout, column mapping, date orientation, ignored lines, counts. The
dangerous decisions here are list-level, not row-level; if they are not in the
output they cannot be shown, confirmed, or tested.

**P2b — Parse-time states are distinct from match states.**
`clean` / `needs-confirmation` / `error` / `ignored` exist before any API call.
`new` / `matched` / `name variant` / `ambiguous` / `already booked` require a
Clubworx read. §9's table gives each its own column for exactly this reason.

**Amended on #65: `unmatchable` is a sixth match state.** A row missing either
half of the identity key — surname or DOB — concludes nothing however many
candidates come back, and the five above have no way to say so. The parser holds
both shapes at `needs-confirmation` and step 4's gates should stop them, so this
is the second line of defence; it exists because the first line failing silently
costs a write that cannot be undone. Calling such a row `new` creates a permanent
contact with no DOB, which then poisons the surname + DOB key for every later
term; matching a surname-less row picks whichever contact shares the birthday.
§9's `CLUBWORX` column must render it.

**P10 — Two normalisations, kept apart.**

| | Rules |
|---|---|
| **Write form** — what is stored | trim; collapse internal whitespace runs; NBSP → space; curly apostrophe and prime → `'`; non-breaking and figure hyphens → `-`; strip zero-width characters and BOM; Unicode NFC. **Never** touch case, **never** strip accents |
| **Compare form** — matching and in-paste dedup only | write form, additionally case-folded, with apostrophes, hyphens and spaces stripped, and **accents on Latin letters folded** (amended on #80) |

**Amended on #80: compare form folds accents.** An accent is the same class of
variance as an apostrophe — one list types it, one contact record does not — and
in a *surname* the mismatch was silent: the candidate never narrowed, an existing
student reported `new`, and a second permanent contact was written with nobody
asked. Write form is unchanged and still **never** strips an accent; that half of
the split is the point of it.

The rule is narrower than #80 proposed, in two steps, because a **false** match
is the worse failure — it attaches a pass and bookings to the wrong child, where
a miss only creates a duplicate contact. Not all of `\p{M}`: in an abugida the
vowel signs are marks, so that rule deletes letters (`प्रिया` → `परय`). And only
marks on a **Latin base letter**: the combining-diacritics block is
script-neutral, so ungated it folds Cyrillic `й` onto `и`, which are two letters
rather than two spellings.

**Vietnamese still folds**, since it is Latin script — `Lê`, `Lệ` and `Lễ` share
one compare form. That is the accepted cost of fixing the reported case, taken
**without** the contact-database count #80 suggested weighing first: a false match
additionally requires surname, birthday and first name to coincide, where the miss
it prevents needs none of that. If that trade is ever revisited, the count is the
evidence to gather. Letters like `ł` and `ø` do not decompose and so never fold;
that residue is #83.

One of the real fixtures is a PDF exported from Word, so curly apostrophes and
non-breaking hyphens are an expected input. A curly apostrophe written verbatim
produces a contact no human-typed search will ever match again.

**P16 — The rules live in a pure, `window`-exported module with vitest tests**,
following the five precedents in `vouchers/` (`delete-logic.js`,
`expiry-flag.js`, `type-surfaces.js`, `unsubscribes-logic.js`, `nav-menu.js`).

### Reading the list

**P4 — Layout is auto-detected, then validated against content, with the DOB as
the anchor.** In a genuine **vertical list**, exactly one *position within the
repeating block* is date-shaped in **every** block. In a horizontal list,
exactly one *column* is. Confirm the hypothesis that way; **neither holding is a
refusal, not a guess.**

State the verdict in plain English — *"read as 6 fields per student — 21
students found"* — with a one-click override.

> The divisibility rule as first written on #48 **does not work** and is
> superseded. All three fixtures are CRLF and the vertical one opens with a
> blank line, so its 37 lines are not a multiple of 6 while its 36 non-blank
> lines are; and almost any line count divides by 2 or 3 anyway.

The failure this prevents is the one #48 actually caught: a row-per-line parser
reads the vertical list as **126 students out of 21**, without erroring.

**P5 — Staff declare the expected student count *before* the parse result is
shown; a mismatch blocks the run.** "I don't know" is allowed and downgrades to
a prominent count banner.

Asking *before* showing is the whole point — a count displayed first is
anchoring theatre, because nobody disagrees with a number already on screen.
This one check catches layout misdetection, junk absorbed as students, a
truncated paste and phantom trailing columns simultaneously, and it is nearly
free.

**P6 — Columns are mapped content-first.** The DOB is the only field whose
identity is readable from its own values, so it is found by shape — the same
anchor P4 uses — never by position or header text. A header, where present, then
names the two name columns. Presented as three labelled chips, swappable in one
click.

**Ignored columns are named on screen**: *"3 columns ignored: FormGroup,
YearLevel, Email."* That line costs nothing and is the tell that the mapping
went wrong. Fixed column order is rejected outright: the first school that
reorders its export would produce wrong permanent contacts with no error at all.

The real form-group column is inconsistent with itself — teacher surnames in
every row but one, which holds a class code. Extra columns are not reliably
uniform and must not be leaned on.

### Names

**P7 — A headerless list gets a one-click order confirmation**, defaulted to
first-then-last, illustrated with two real sample rows read both ways.

This is the most likely *silent* misread in the pipeline: both fields are
strings that look like names, nothing downstream validates the order, the
identity search simply fails to match, and the result is a permanent reversed
contact with a permanent School Pass on it. Content-based inference is rejected
— hyphenated and apostrophe names appear in *both* fields in the real lists, so
it is a guess dressed as inference.

**P8 — A combined name column is supported, with graded confirmation.**

| Input | Handling |
|---|---|
| Exactly two tokens after trimming | **Auto-split.** No other reading exists (which way round is P7's problem) |
| A comma inside the name field | **Auto-split** as `Surname, Given`; confirmed **once for the list**, not per row |
| Three or more tokens | **Per-row confirmation**, offering split points as clickable positions with a suggested default |

The fixtures overturned the original recommendation to refuse a combined column:
only **3 of 63 first names and 1 of 63 surnames** contain an internal space, so
the largest real list needs about **four confirmations, not sixty-three**.
Confirmation fatigue was the objection and it does not survive the numbers.

**No particle list** (`van`, `der`, `de`, `mac`, `o'`) is maintained. Every such
name has three or more tokens anyway, so the token rule catches them without a
list that is culturally incomplete by nature and silently wrong when it misses.

### Dates

**P11 — Orientation is a property of the whole list**, inferred once and applied
to every row.

| Case | Ruling |
|---|---|
| One date with a field > 12, nothing contradicting | **Fixes the whole list.** A proof, not a heuristic |
| `yyyy-mm-dd` | Self-identifying |
| Two-digit year | **Accepted as 20xx** (see P12) |
| Evidence for **both** orientations in one list | **Refuse the whole paste**, showing the two contradicting rows |
| Every date individually ambiguous | **Ask**, showing a real date from the paste read both ways |

Never default silently. A wrong orientation does not error: it converts March to
May, the student is reported not-found, and the tool creates a permanent contact
carrying a wrong DOB — which then poisons the surname + DOB identity key for
every subsequent term.

**P12 — Excel serials convert on the 1900 epoch, with the resulting dates shown
for a sanity check.** They are **not unambiguous**: 1900 and 1904 are 1462 days
apart, so a bare `40365` is either 2010-07-06 or 2014-07-07 — both plausible
school ages. Asking staff which date system their workbook uses is unanswerable;
nobody knows. What staff *can* verify is whether the resulting birthdays imply
the right ages, so the confirmation is on the dates, not the mechanism.

Rare in practice: v1 is paste-only and the clipboard carries the *displayed*
value, so serials arrive only when the column is formatted as General.

**The century constraint** settles two things — students are all born this
century, so **two-digit years are 20xx**, and **any parsed DOB before 2000 is
flagged as not-a-student**. That is a far sharper teacher-row detector than
guessing at names. (It does *not* resolve 1900-vs-1904; both readings land after
2000.)

**P13 — An implausible age is `needs-confirmation`, not a block.** The row
cannot be written until explicitly ticked; the run is not refused. A hard block
would refuse the legitimate senior student or an 18-year-old on a leadership
day. Age is computed against the **event date** in `Australia/Perth`, with a
generous outer band (roughly 4–21).

### Rows

**P14 — True duplicates collapse visibly; twins stay as two rows.**

- Same surname + DOB + same first name → collapse to one row, badged *"listed
  twice"*. Silent collapsing is not acceptable; this happens when a school merges
  two class exports.
- Same surname + DOB, **different** first name → **keep both**, badged *"possible
  siblings"*. That is twins — exactly the case the tie-breaker exists for.

Both names are compared in **compare form**, surname included — so since #80 the
two class exports need not agree about an accent either. The surviving row keeps
the spelling the list used first, and write form is what reaches Clubworx.

Collapsing on surname + DOB alone is rejected: it merges twins into one student,
and nobody discovers the missing child until the session.

**P9 — Junk is defined by position.** A line is **junk** when it holds no
date-shaped value **and** its field count differs from the modal count **and** it
sits **before the first successfully parsed record**. Anything failing **after**
the first good record is **unparseable, not junk** — that is where a real student
hides.

Leading whitespace is trimmed *before* splitting; with that, the fixtures
separate cleanly — the school title line and the stray prose sentence both
collapse to a single field, data rows do not.

Display: the ignored **count** is always on screen; the lines themselves live in
a collapsed drawer. Showing six struck-through header lines above the data on
every paste trains staff to stop reading that region.

**P15 — An unparseable row blocks Apply** until corrected inline or explicitly
dismissed. P1 applied literally: the run cannot start while any line is
unaccounted for, but a human can account for one.

---

## 8. Event selection

No series or recurrence field exists in the API, so **any automatic rule is a
guess.** Staff pick the first event; same-name, same-location events ahead of it
arrive **pre-ticked and correctable**.

`GET /events` **ignores `contact_key` entirely** and returns the gym-wide list
(#51), so the picker is unblocked. Two traps come with it:

- **The date window is required.** Omitting it does not return everything.
- **A full page is silent truncation** — no total, no next-page link, no header.
  Page to exhaustion and treat a full page as incomplete.

There is also an **event-ID fallback**: staff can paste a Clubworx event id
directly, for the case where the search does not surface the event (an unusual
name, or a window edge). The id is resolved and shown with its name, date and
`spaces_available` for confirmation before it can be selected — it is a shortcut
past the search, never past the confirmation.

### The fallback resolves page-side — amended on #72

#67 built the fallback on `GET /events/:id`. #97 then measured that route against
production on 2026-08-21: it answers **404 for every id**, real or invented, with
the date window and without it. A real currently-listed id and `999999999` come
back identical, so nothing there reads the id at all.

The Worker route survives only as an honest refusal — every call is a 502
carrying Clubworx's own `"Not Found"` — and that message is the problem: it reads
to a staff member as *this id does not exist* when the truth is *this endpoint
does not exist*. A working id would look like a typo, and the person would go and
"fix" something already correct.

So **#72 resolves the pasted id in the page**, against the window the picker has
already walked. `resolveEvent` is left in place, unreachable from the page, for
the reason its own header gives: deleting it would decide a question #97 handed
over rather than answering it.

Two consequences, both accepted:

- **The fallback cannot reach outside the loaded window.** It therefore says
  *not in this window — widen the dates*, and **never** *no such event*. Those
  are different problems with different fixes, and only one of them is knowable
  here.
- **It costs no request.** An id inside the window is already on screen, so the
  lookup is a array scan rather than up to `MAX_PAGES` requests of a gym-wide
  75-a-minute allowance — which is what the re-walking alternative would have
  spent to find a row the page was already holding.

What the paste still does not survive is Clubworx enforcing the `contact_key` its
reference documents. That would take `/events` down as a whole, and the window
this resolves against comes from the same endpoint. No page-side arrangement
outlives its own API.

---

## 9. The page

**Variant A — the gated stepper**, carrying **variant C's inline row
resolution**. Decided on #54 against three built prototypes, on branch
`prototype/54-school-booking-ui`.

One screen per step; each gate is a screen you cannot skip.

```
1 School      2 Paste       3 Rows        4 Sessions    5 Preview     6 Result
  pick slug     + declare     parse         event         READ/          rows mutate
                the count     result        picker        CLUBWORX/      in place
                (P5)          + fixes                     OUTCOME
                                                          + Apply
```

### The row expands in place

A two-pane cockpit has somewhere to put a detail panel; **a single-column
stepper does not**, and a modal would be a gate inside a gate. So the row
expands inline.

**Both the Rows step and the Preview step are resolvable.** This is not symmetry
for its own sake: parse states exist from step 3, but **match states only exist
after the Clubworx check between steps 4 and 5**. A rows-only affordance cannot
resolve a name variant; a preview-only one cannot resolve an unreadable line.
Either alone leaves half the exceptions unreachable.

**Resolving does real work** — the gates visibly clear as they are worked, and
Apply lights up when the last one goes. That is what makes "refuse and let the
human fix it" a workflow rather than a dead end.

### Two rules constraining the resolution controls

- **Dismissing a row reclassifies it to `ignored`; it is never removed.**
  Dropping it breaks P1 — the three counts stop summing. **The reconciliation is
  asserted after a dismissal, not only after a parse.**
- **Accepting an unreadable line as a student legitimately moves the declared
  count**, so the mismatch offers a re-declare — **but only once staff have
  edited rows themselves.** Ungated, that button is a one-click dismissal of the
  gate P5 exists to enforce. The gate must survive its own escape hatch.

**Amended on #71: the gate asks whether staff worked the rows, not where the
count sits.** Built first as "the record count has moved from what the parser
read" — a tightening of the sentence above, on the reasoning that only a
resolution can move it. Two faults, both found in use within a day:

- **It swings shut behind an undo.** Dismiss a row, re-declare to the new
  number, then put the row back: the count matches the parse again, the button
  disappears, and the mismatch staff are now stuck on has no way out but
  re-pasting the whole list. The milder daily version is the button reappearing
  on every "put it back" except the last.
- **It rewards dismissing a real student.** Staff who have read the rows and
  concluded the list really is what the parser said cannot unlock the button
  without moving the count — so the only route forward is to drop a child who
  belongs there. A gate that makes the destructive action the unlocking one is
  worse than the anchoring it was guarding against.

So the log remembers a resolution that was taken back, rather than erasing it:
the row returns to exactly where the parse put it, and the log still says it was
worked on. Taking an edit back does not un-read the list. **Confirming a row
still does not count** — that is agreeing with the parser about one row, which
says nothing new about how many students there are.

### The preview table

Three columns, one per state axis:

| STUDENT | DOB | READ | CLUBWORX | OUTCOME |
|---|---|---|---|---|
| A. Smith | 12/03/2011 | `clean` | `new` | will book ×6 |
| B. Jones | 04/11/2010 | `clean` | `matched` | will book ×4 |
| C. Nguyen | 21/07/2011 | `needs-confirmation` | — | blocked |

`READ` is the parse state, `CLUBWORX` the match state — P2b's separation made
**structural** rather than folded into the student cell as a pill. Reading *down*
a column is how you spot that every row is `clean` but three are `new`, which is
the scan this screen exists for.

### Where the per-row consequence lives

**Decided on #55.** The consequence sentence gets an **aggregate line above the
table** plus **the full per-row sentence inside the expanded row**:

```
┌────────────────────────────────────────────────────────────┐
│ This will create 4 contacts (permanent) and 4 School       │
│ Passes (permanent), and make 34 bookings (cancellable).    │
└────────────────────────────────────────────────────────────┘

▾ B. Jones   04/11/2010   clean   matched   will book ×4
    └ create nothing · pass already active · 4 bookings (2 already booked)
```

Three properties earn it:

- **Preview and result become the same line in two tenses.** D11 makes the
  preview table *become* the result table; the aggregate line above it is the
  same sentence, future tense before Apply and past tense after
  (*"4 contacts created (permanent) · 4 passes · 34 bookings made · ⚠ 1
  stranded"*). One place to read the run's consequence, in both directions.
- **Commitment is a whole-run decision, not a per-row one.** Staff approve the
  run, not each student. A permanence sentence repeated on 63 rows is the
  repetition that trains people to stop reading a region — the same argument P9
  uses against showing struck-through junk lines.
- **Nothing is lost.** The per-row detail, including the rows that differ (a
  matched student already booked into two of six sessions), lives in the
  expanded row that #54's inline resolution already builds — one click away,
  exactly where a human is looking when they care about that row.

The permanence words stay in **both** places. This is the screen where two
irreversible records per new student are committed, and #60 is what made that
two rather than one.

---

## 10. The write chain, and the failure model

Settled on #53. The posture behind nearly all of it: **refuse and let the human
fix it, rather than silently adjust.**

**D1 — The browser drives the run, one Worker call per student.** A four-minute
one-shot response is not a shape the web is good at, and its failure mode —
writes landed, log lost — is the unrecoverable one here, because a contact can
never be deleted. Per-student calls make every completed student durable on the
client the instant it lands.

**D2 — The unit of work is one student, across all their events.** It is the
only unit whose failure boundary is a sentence staff can say out loud:
*"the first six are in, the rest are not."* Per-event strands a student who
turns up to session 4 and is not on the list. Per-phase is worst of all — 25
permanent contacts with no pass.

**D3 — All-or-nothing per student, with rollback.** Any failure in the chain
abandons that student, and **the bookings this run already made for them are
cancelled**. A student is in every session or in none, never half-booked.

The rollback is what makes "all-or-nothing" true rather than nominal. The
student is still left with a permanent contact and pass and no bookings — a
**stranded student**, which the result table must name (§12).

**D4 — No membership read for a contact we just created; read at Apply for
matched contacts.**

| Case | Read-then-write | Blind assign |
|---|---|---|
| New contact (provably holds no pass) | 1 read + 1 write = **2** | **1** |
| Returning, holds a **covering** pass | 1 read, skip = **1** | **1** |
| Returning, pass expired | 1 read + 1 write = **2** | **1** |

The read is only ever wasted on a contact we just created. For a student who
already holds a covering pass, reading and assigning cost the **same single
request** — so blind assignment buys nothing in exactly the case where it would
create the duplicate.

**The test is *covers the last selected session*, not *active today*.** Amended
2026-08-20 with the 26-week pass (§3, ADR 0005). Compare the held pass's
`expiration_date` against the latest selected session date, inclusive. *Active
today* is the answer that hides the problem, because every booking is written on
a day the pass is active and the shortfall surfaces weeks later at a session
nobody is watching.

**Consequence: whether a second School Pass duplicates matters again.** It was
not load-bearing while D4 only ever assigned to a holder with no live pass. At 26
weeks the middle row above splits — a returning student can hold a pass that is
active and **not** covering — and granting the covering pass means granting a
second one to a live holder. Still not probed, because memberships have no
delete; carried on [#90](https://github.com/urbanjungleirc/staff-site/issues/90)
and §15. **Until it is answered, a non-covering live pass is a
`needs-confirmation` row rather than a silent second grant** — §11's posture:
refuse and let the human fix it.

**D14 — The membership is re-read at Apply, immediately before its own write.**
Preview reads can be minutes old. Contact and booking both have server-side
idempotency to fall back on; the membership is the one write with no such
guarantee. Reading at Apply costs the same single request and removes the
staleness. Nothing else is re-validated.

---

## 11. Refusals, retries, and the error vocabulary

### Refused before any permanent write

| Condition | Ruling |
|---|---|
| School Pass plan unresolved, or the name ambiguous | **Hard-stop the run** |
| Any selected event starts inside the 24-hour lead time | **Hard-stop**, with the reason on screen and a one-click *"remove this session"* |
| No events selected, or zero parseable rows | **Hard-stop** |
| Any unresolved gate — unparseable row, count mismatch, unconfirmed age | **Hard-stop** (§9) |
| The last selected session falls outside `today + membership_duration` | **Hard-stop the run** (§3, ADR 0005) |
| `membership_duration` unparseable — it is a human string | **Warn on screen**, naming the raw value. Never skip the coverage check silently |
| `spaces_available` below the student count | **Warn, never block.** That number has been wrong in both directions |

**D9, the lead time.** Dropping the event automatically was rejected as a silent
adjustment. Staff must never meet Clubworx's own message here — *"Sorry! This
class is now closed for bookings."* — which names no cause and reads like a
capacity problem.

### Retry policy

**D8 — Retry only `429`, network errors and `5xx`.** Never retry a `400`: all
three known 400s are permanent for that attempt, and the fourth kind is unknown
by definition. Backoff floor ~20 s (#51 measured ~18 s of throttling), maximum 2
attempts.

**A `429` pauses the whole run**, not one row. The allowance is account-wide, so
backing off a single row while the others continue just spends the next window
failing. The message is honest that the cause may be elsewhere: *"Clubworx is
busy — this can be caused by another system, not this page. Try again shortly."*

**D7 — Circuit breaker: halt after 3 consecutive failures**, or immediately on a
`429` that survives backoff. One row failing is data; a run of failures is a
systemic condition — #51 showed the throttle failure mode is not scattered rows
but the entire back half of the list (49 successes, then 41 consecutive `429`s).
The halt states its reason and leaves completed rows intact.

### The error vocabulary

**Three distinct refusals share HTTP `400` and the shape `{"error": "..."}`. The
message string is the only discriminator.**

| Clubworx says | Row outcome | Shown as |
|---|---|---|
| *"Woops! You've already booked into this class!"* | **success-equivalent** — `already booked` | never styled as an error; it *is* the idempotency guarantee |
| *"Sorry! This class is now closed for bookings."* | permanent, that event only | should never be reached — pre-empted by the lead-time hard-stop |
| *"Sorry, this class has no free spaces available."* | ambiguous **by construction** (prospect allowance, not capacity) | *"Refused — check the session"*, with `spaces_available` beside it. **Never** "class full" |
| anything else | `unknown` | **verbatim**, attributed to Clubworx, never retried, never re-worded, counted toward the circuit breaker |

**D6 — Paraphrasing an unrecognised message is what makes new Clubworx behaviour
invisible.** #50 is the cautionary tale: a truthful-sounding message pointed at
entirely the wrong mechanism and cost an architectural route.

---

## 12. Irreversibility, and what the UI does about it

This is the section to read if you change nothing else.

| Record | Reversible? | How |
|---|---|---|
| **Booking** | **Yes** | `DELETE /api/v2/bookings/:id` — **measured** in #60, verified by re-reading rather than by its status code. Requires `contact_key` alongside `account_key`, **form-encoded in the body** |
| **Contact** | **No** | The API exposes list / show / create / update only, on all three status endpoints. **Measured** — 42 endpoints reviewed, no delete. Removable only by hand in the Clubworx UI, against a ~60,000-profile database |
| **School Pass membership** | **No** | **No delete appears in the reference, and none was attempted.** This is *inherited from the reference, not measured* — and the reference has been wrong twice on this effort (below). It is treated as permanent because there is no safe way to find out: a failed probe would leave the permanent record it was testing for |

So the undo asymmetry is exactly: **bookings yes, contacts and memberships
never.** It is narrower than the map first feared — #50 wrongly reported that
bookings could not be deleted either — but it is still an asymmetry, and the UI
must never imply that undo restores the prior state.

**One stranded case is now unreachable.** #63 adopted the one-call create for
new students (§2), so "contact created, then the pass call failed" cannot happen
to a student this tool creates — the contact and the pass are a single request.
A **found** student can still be stranded that way, and every student can still
be stranded by D3's rollback, which cancels bookings and leaves the permanent
contact and pass behind. The result table must still name them.

### Two things the reference got wrong

Both were caught by probing rather than reading, and both changed the design:

1. **#50 concluded `DELETE /bookings/:id` does not work**, on the strength of a
   `401 "Authorization failed"`. That was a malformed request — the call needs
   `contact_key` as well as `account_key`. Sent correctly, it reverses cleanly.
   A permissions-shaped error meant a missing parameter.
2. **`GET /membership_plans` returned exactly 50 plans** when UJ has 57, and
   School Pass was among the seven that never arrived. Nothing said so.

The lesson the spec carries forward: **an authoritative-looking answer from this
API is not evidence.** Verify a write by re-reading the resource, never by the
status code, and treat a full page as truncated.

### What the UI does

**D12 — There is no button called "Undo".** There is **"Cancel bookings from
this run"**, with the permanence of contacts and passes stated **beside it**,
not in a footnote.

It acts on rows marked `booked` and **never** on rows marked `already booked`.
This is a **safety interlock, not a display distinction**: because booking is
idempotent, a re-run marks rows `already booked`, so a cancel scoped to the
whole row set would delete bookings this run did not create — possibly a session
a real member booked themselves, which #50 identified as the worst outcome
available on this map. D3's automatic rollback runs the same code path with no
human present, so the interlock protects both.

**D11 — The preview table becomes the result table**, same rows, same order,
state mutating in place. The summary keeps the three permanence classes separate
rather than collapsing them into a success count:

> 6 contacts created (permanent) · 6 School Passes assigned (permanent) · 34
> bookings made (can be cancelled) · 2 already booked · 1 refused — see row 7
>
> ⚠ 1 student has a contact and a pass but no bookings.

**Naming stranded students is not optional decoration.** Under D3's rollback an
abandoned student is *guaranteed* to be stranded, so it is a routine outcome
staff must be able to see and finish by hand.

**D10 — Records live in the browser only.** Result rows are written to
`localStorage` as each student completes, with copy-to-clipboard and download.
The specific failure this defends against is a page reload destroying the only
record of creations that cannot be undone.

### Doing it twice

**D5 — Recovery is a restart-safe re-run. No stored run state, no resume.**
Re-paste the same list, pick the same sessions, run again. Every write is safe to
repeat: the contact via the three-view dedup search, the membership via D4's
guard, the booking because Clubworx refuses the duplicate itself.

The word *resume* is deliberately avoided — it implies stored state this design
does not keep. The cost, stated at the confirm step: a no-op re-run still spends
~3 minutes of the shared allowance.

**D13 — A deliberate re-paste needs no special handling.** The preview is the
guard: it shows 0 new contacts, 0 new passes, N already booked. Warning against
it would train staff to click through the warning on the one path D5 prescribes
for recovery.

**A double-click on Apply, or a mid-run resubmit, is different** and does need a
single-flight lock: Apply disabled while a run is in progress, plus a
`beforeunload` warning.

---

## 13. Two API traps that stop a run dead

**Plan lookup must page.** `GET /membership_plans` truncated at **50 of 57** and
hid School Pass entirely. A lookup on the default page reports "no such plan"
and the whole run stops, for a plan that plainly exists. So:

- Always request a `page_size` past the default, and **treat a full page as
  truncated** rather than as an answer.
- **Refuse an ambiguous name.** Two plans sharing a name is an error, not a
  first-wins — assigning the wrong plan is permanent.

`findPlanByName` in `probes/lib/report.mjs` already implements both.

**Active is derived, never read.** A membership has no `status` field. Derive
from `start_date`/`expiration_date`, inclusive at both ends. `summariseMemberships`
already distinguishes *holding the plan* from *holding an active one*, which
matters because an expired pass is still a returned row.

---

## 14. Testing plan

**Note honestly:** `pages.yml` is this repo's only workflow and it **runs no
tests**. Everything below is run by hand with `npx vitest run` until that
changes — the same open recommendation `ACCESS.md` already carries. Wiring
vitest into CI is filed as its own issue.

### Unit — pure modules, no network

| Module | Covers |
|---|---|
| `school-booking/parse.js` | P1 reconciliation (`records + ignored + errors == lines`) on every fixture; vertical vs horizontal detection; the both-orientations refusal; two-digit years; pre-2000 rejection; Excel serials; combined-name splits; junk-vs-unparseable by position |
| `school-booking/identity.js` | write form vs compare form; `O'Brien` ≡ `OBrien`; accents and case preserved on write; twins kept apart; true duplicates collapsed |
| `school-booking/outcome.js` | the four `400` classifications; `already booked` as success; unknown passed through verbatim; the `booked` / `already booked` cancel interlock |

**Acceptance bar:** all three committed fixtures parse to their exact expected
record counts, plus a synthesised phantom-trailing-column variant and a
CRLF/leading-blank variant.

### Integration — stubbed Clubworx, no network

Run the Worker's write chain against a fake that reproduces measured behaviour:
form-encoded bodies, `200` (not `201`) on create, the three `400` strings, the
50-plan truncation, the missing `status` field.

- **Idempotent re-run — now three writes, not one.** The original plan tested one.
  Under this route a re-run repeats **contact, membership and booking**, and the
  idempotency of the first two is **unproven against production**: the contact is
  idempotent only because *our* dedup search finds it, and the membership only
  because of D4's read-then-write guard. Only the booking is idempotent
  *server-side*, measured. So the integration test asserts the guards, and the
  UAT below is what checks them against the real thing.
- All-or-nothing: an injected failure at the booking step rolls back that
  student's bookings from this run and leaves them stranded and named.
- Circuit breaker halts on the third consecutive failure, and immediately on a
  `429` surviving backoff.
- The cancel interlock never touches an `already booked` row.

### UAT — one real school list, one real event

Run against production with **one real list and a purpose-made School Session**,
in this order:

0. **Create one contact, by hand through the tool's own Worker route, and read
   it back.** This is §2's unmeasured write. Confirm `POST /members` is accepted,
   confirm the contact is bookable once it holds a pass, and confirm whether
   `membership_plan_id` on create produces a usable pass and with what
   `start_date`. Nothing below is meaningful until this is answered.
1. Parse only. Confirm the count gate, the layout verdict and the ignored-column
   line before anything is written.
2. Apply for **two students**. Verify in the Clubworx UI: two members, two School
   Passes with the expected `expiration_date`, bookings present.
3. **Re-run the same two.** Expect 0 contacts, 0 passes, N `already booked`.
   This is the only real test of the three-write idempotency claim.
4. *"Cancel bookings from this run"*, then re-read to confirm the bookings are
   gone and the contacts and passes are not.
5. Then the full list.

**Everything created in UAT is permanent** — the contacts and passes cannot be
removed through the API. Use a marker slug that makes them findable
(`noreply+uat-<date>@`) and record what was left behind, as the probes do.

---

## 15. Known gaps and open questions

Carried forward deliberately. None blocks the build.

- ~~**Whether a School Pass is checked against the session date, or only at
  booking time.**~~ **Closed 2026-08-21 — it is checked both ways.** A booking is
  refused past the pass's expiry *and* before the pass is active (confirmed from
  Clubworx's behaviour, [#90](https://github.com/urbanjungleirc/staff-site/issues/90)).
  The 26-week plan (§3, ADR 0005) was therefore necessary rather than merely
  safe, and the coverage checks are load-bearing. **What replaces it:** the
  refusal's message string is unrecorded, so §11's vocabulary will classify it
  `unknown` — safe, but uninformative — until a run captures it.

- **Whether `POST /api/v2/members` works, and whether it can carry
  `membership_plan_id`.** The one write in the chain that has never been run —
  see the callout in §2. Resolved by the first implementation ticket, before
  anything depends on it. This is the only gap in this list that could change
  the design.
- **Whether `spaces_available` blocks at the cap.** #60 read 25 free and booked
  one — consistent, not proven. #50 caught the same field being actively
  misleading. The design only *warns* on it, so nothing here depends on it, but
  the warning's wording should not be trusted further until probed. Filed as its
  own issue.
- **Whether a second School Pass on an active holder duplicates it.** **The only
  open question left on the pass**, and the sharper half of #90. Not probed, on
  purpose — memberships have no delete, so the probe would leave the permanent
  record it was testing for. D4's read-then-write guard closed it for
  free while *active* meant "active today". **The 26-week pass reopens it**: a
  returning student will now often hold a pass that is active today and expires
  mid-term, and granting the pass that covers the term means granting a second
  one to a live holder. See §3.
- **What a term's intake does to Clubworx reporting.** These are now *members*,
  not prospects, so a school group lands in member counts, retention and revenue,
  and an expired School Pass leaves a **lapsed member** rather than a stale
  prospect. Whether that needs archiving, marketing suppression (Resend), or any
  cleanup at all is unresolved — and contacts cannot be deleted, so the options
  are narrow. **Sharper since the pass went to 26 weeks:** an intake reads as
  current members for six months rather than three, and lapses mid-following-term
  rather than at the end of the term it attended. Open on #46.
- **Who may run the tool.** staff-portal is Access-gated as a whole; bulk
  creation of permanent contacts may warrant a narrower allowlist, as the
  voucher hard-delete has. v1 gates on Access alone and records the verified
  email on every write, so this can be decided on evidence.
- **Attendance after the session.** Bookings carry a `state` of `attended` /
  `absent` / `not_attended`. Whether this tool or anything else should mark it
  is unexplored.

---

## 16. Build conventions

### Never bind an Alpine directive to a function-valued property

Found while prototyping #54, and it defeated a safety gate:

```html
<!-- WRONG -->
<div x-show="b.fix">…</div>
```

Alpine **invokes** a function returned by an expression, so this **ran** the
blocker's "confirm all" fix on **every render tick** — silently confirming rows
nobody had confirmed. The confirmation gate was being defeated by its own
affordance, continuously, with no user action and no error.

```html
<!-- RIGHT -->
<div x-show="b.needsFix" @click="b.fix()">…</div>
```

Bind to a **string or boolean** property; call the function only from `@click`.

It was caught only because a screenshot showed `CONFIRMED` pills on two rows
while the blocker above them still named those exact rows as needing
confirmation. Worth knowing for the build: **neither the state model nor the
rendered text was wrong on its own** — they were individually plausible and only
contradicted each other.

This belongs beside the `x-init` double-bootstrap note in `vouchers#69` as a
house convention; it is recorded here because this repo has no conventions file
of its own.

### Others

- **Pure logic goes in a `window`-exported module with vitest tests**, following
  the five precedents in `vouchers/`. Bump the `?v=` on the import whenever
  exports change — a stale cached copy of a gate module is the failure that
  breaks every check simultaneously and silently.
- **Verify a write by re-reading the resource, never by the status code.**
- **Never log a request or response body** in the Worker (§6).

---

## 17. Implementation order

**`main` is production on this repo.** GitHub Pages publishes to
`ujstaff.happyk.au` on every push, with no approval gate — so **merging is
deploying**. The order below exists because of that:

1. **Pure modules first.** A JS file no page imports is inert in production.
2. **The Worker before the page.** A page calling a route that does not exist is
   a broken tool on the live hub.
3. **`tools.json` last.** The page is unreachable from the hub until its entry
   lands, so every step before it is invisible to staff even while deployed.

The Worker deploys separately (`npx wrangler deploy`); a Pages publish does not
touch it.

---

## 18. Out of scope

- **Image and OCR input.** Deferred to a second effort once the text path is
  proven — it needs a vision model, an API key, a per-parse cost and its own
  extraction-verification surface. Wanted, not here.
- **Merging or de-duplicating existing Clubworx profiles.** The API exposes no
  merge operation.
- **Creating or approving waivers.** Both stay manual in Clubworx.
- **The general participant matcher** ([#45](https://github.com/urbanjungleirc/staff-site/issues/45)).
  Parked until Clubworx exposes waiver or pending-review data.
- **File upload.** Copying a selection out of Excel or Sheets already puts
  tab-separated text on the clipboard, so one paste box covers xls, csv and typed
  lists with no file parsing.

---

## 19. Privacy note

**staff-site is a public repo.** No real student name, date of birth, school
name or list may appear in any issue, comment, commit, test fixture or
screenshot. The three real lists live in `docs/school-lists/` **anonymised**;
real material goes to `uj/private-archive` or stays local and gitignored.

Every example in this document is invented.

---

## References

| | |
|---|---|
| Map | [#46](https://github.com/urbanjungleirc/staff-site/issues/46) |
| API access, key handling, secret hygiene | `cloudflare-clubworx/ACCESS.md` |
| Probe rules (pacing, no production data) | `cloudflare-clubworx/probes/README.md` |
| Plus-addressed marking | `cloudflare-clubworx/probes/49-plus-addressed-duplicates.md` |
| Prospect route failure | `cloudflare-clubworx/probes/50-membership-less-booking.md` |
| Events, rate limits, truncation | `cloudflare-clubworx/probes/51-events-and-burst.md` |
| Member + School Pass route | `cloudflare-clubworx/probes/60-member-school-pass-booking.md` |
| Real list shapes | `docs/school-lists/README.md` |
| Domain glossary | `CONTEXT.md` |
| Term weeks | `docs/adr/0002-uj-term-weeks-are-snapped.md` |
| Page prototypes | branch `prototype/54-school-booking-ui`, `school-booking-prototype.html` |
| Clubworx API reference | `uj/automations/ClubworxAPI_docs.md` (not in this repo) |

> **Correction to #46.** The map cites a parked sibling design at
> `docs/superpowers/specs/2026-08-13-event-participant-matching-design.md`. **That
> file does not exist** — not on this branch, not on `main`, not in any branch's
> history. The parked work is [#45](https://github.com/urbanjungleirc/staff-site/issues/45)
> itself, which is where its reasoning actually lives.
