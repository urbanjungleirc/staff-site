# Domain glossary — staff-site

The language this repo uses for its own concepts. When naming things in code,
issues, tests or commits, use the term as defined here rather than a synonym.

Architectural decisions live in [`docs/adr/`](docs/adr/).

## Roster calendar context

Terms describing what kind of day a roster date is. Implemented in
`cloudflare-worker/src/calendar.js` and served by `/api/calendar`.

### UJ term week

A Monday–Sunday calendar week within a school term. Week 1 begins the **Monday
of the week containing the official term start**, even when school starts
mid-week. Sunday closes the week.

Terms run 9, 10 or 11 UJ term weeks. Never assume 10 — 2026 has one of each of
the first two.

*Avoid*: "school week", "teaching week". Those imply the official WA definition,
which is not what we compute.

### Term snapping

Expanding the official WA term dates outward to whole UJ term weeks: the start
back to its Monday, the end forward to its Sunday.

UJ classes run Monday–Saturday regardless of where the official dates fall, so
the first Saturday after school finishes is still term for us. This deliberately
deviates from the official definition — see
[ADR 0002](docs/adr/0002-uj-term-weeks-are-snapped.md) before changing it.

### School break

The period between two snapped terms. Because snapping always ends a term on a
Sunday and starts the next on a Monday, a school break is **always exactly 14
days, or 42 across summer**. That invariant is asserted across the whole term
table in `cloudflare-worker/test/calendar.test.js`.

A school break advertises the date the next term starts. That is the *snapped*
Monday — the first day we ourselves call term — not the official start date.

*Avoid*: "school holidays" as a code identifier. It is the right phrase in the
UI, but "break" is the term in the data.

### Public holiday

A WA-gazetted holiday, including substitute days. Substitute days are distinct
dates, not annotations: Anzac Day 2026 legitimately occupies both Saturday 25
and Monday 27 April.

Fetched live and cached, unlike the term table beside it — see
[ADR 0001](docs/adr/0001-hybrid-calendar-sourcing.md). On the wire, a date
carries `publicHoliday: { name }` or `null`. In the UI it is a **badge in front
of** the term context, never instead of it, so the week number survives on the
days staff most want it.

*Avoid*: deduplicating by name, anywhere. Two dates sharing a name is the
substitute-day rule working correctly.

### Calendar staleness

Two distinct conditions, deliberately shown differently, and each half of the
calendar can be in either independently:

- **Broken** — the answer is missing. Amber and visible. Either the term table
  does not cover the date being viewed (`state: "unknown"`), or the holiday feed
  failed with nothing cached to fall back on (`holidaysAvailable: false`).
- **Ageing** — the answer is present but wants attention. Muted grey, because
  only the maintainer can act on it and staff should not be trained to ignore
  warnings. Either the term table is within six months of running out, or the
  holidays were served from cache after an upstream failure
  (`holidaysStale: true`).

These name the *warning tiers*, not the wire format. A day whose state the table
cannot determine is `state: "unknown"` on the wire; **broken** is the tier that
state puts the display into. The CSS classes are `is-broken` and `ctx-broken`
for that reason.

A broken holiday half never breaks the term half: the amber line sits *beneath*
a term context that still renders. Term context does not depend on the feed.

Green is reserved for the "on now" shift state and is never used for calendar
states.

## Voucher type editor

Terms describing how a voucher type's settings are organised. Implemented in
`vouchers/type-surfaces.js` and consumed by the type editor in
`vouchers/index.html`.

### Surface

The output a group of a voucher type's fields actually produces. A type has
exactly three: **Setup** (behaviour — identity, rules, limits, and the staff
redemption warning; no customer-facing output), **Email** (everything that
renders into the customer's voucher email, branding included), and **Public
page** (everything that renders onto the public purchase page).

Surfaces are the editor's organising principle — one tab each — and the
partition is exported as data from `type-surfaces.js` rather than implied by
markup, so "which surface owns this field?" is answered by reading a constant.
See [ADR 0003](docs/adr/0003-voucher-type-editor-organised-by-surface.md).

*Avoid*: "section", "card", "tab" when you mean the grouping itself. A card is
one visual box; a surface may contain several. A tab is how a surface is
reached.

### Physical voucher

A voucher whose type is flagged `is_physical` — it is a card handed over at the
counter, not an email. The flag lives on the **type**, never on the create form,
so "is this one physical?" is always answered by the created voucher's
`is_physical`, which the create response carries.

It is the flag that decides both halves of the handover: no email is sent, and
the create confirmation instructs staff to write the voucher code on the card.
That instruction is the only thing on screen that says so, so it must stay
conditional — on an emailed voucher it is noise.

*Avoid*: "printed voucher", "card voucher". The staff badge, the type editor
checkbox and the column all read *physical*.

### Unsent voucher

A voucher that was due to reach someone by email and hasn't — the counterpart
to a physical one, which is never unsent because no email was ever due.

Defined canonically in the **vouchers** repo, `docs/CONTEXT.md`, because it is a
state of the voucher record rather than of this page. The hub renders it in
three places (the create result, the detail view, the search list) and asks
`unsent-voucher.js` in all three rather than restating the rule.

*Avoid*: "undelivered" — the email provider owns that word and means something
we do not track. *Avoid*: "pending" — nothing retries it on its own; a staff
member has to resend.

### Hero backdrop / hero artwork

Two different public-page images, with **different blank behaviour**, which is
why they never share a word.

The **hero backdrop** (`hero_background_url`) is the full-width band behind the
hero. Left blank, the page draws a gradient derived from the type's brand
colour, so a blank backdrop still renders something.

The **hero artwork** (`hero_image_url`) sits beside the hero copy. Left blank,
nothing renders — there is no colour fallback for it.

*Avoid*: "hero image" unqualified. It reads as either one and the difference is
the whole point.

Note that neither image is *theme-inherited* at render time (below), but both
are **seeded** into a new type from the Gift Voucher type by the editor — so a
new type does start out carrying that product's artwork. Seeding and
inheritance are different mechanisms and the difference matters when reasoning
about what a customer will see.

### Theme inheritance

The rule that a **blank** public page field on a voucher type falls back to the
Gift Voucher type's value, and then to the page's built-in default.

It is **per field, not per type**: a partially filled public page inherits only
the fields left blank. The two hero image fields are exempt — they do not
inherit at all (see above). The editor makes this visible with a chip on an
untouched tab and, when creating a type, a confirmation before saving a surface
that was never opened; neither changes the cascade itself.

Inheritance applies to types whose columns are **null**. Because the editor
seeds a new draft from the Gift Voucher record, a type created through the UI
usually has no null columns to inherit through — it holds copies instead. The
chip therefore appears mainly on types created before seeding, or through the
API. See [ADR 0003](docs/adr/0003-voucher-type-editor-organised-by-surface.md).

## Voucher expiry

Terms describing how close a voucher is to its expiry date. Implemented in
`vouchers/expiry-flag.js` and, for the dashboard counter, in the payments
Worker's `GET /v1/vouchers/stats`.

### Expiring soon

A voucher that is **still usable** and whose expiry falls within the next **30
days**, counting from today in Perth. Both halves are load-bearing: a cancelled
or fully redeemed voucher is not usable and never qualifies, a voucher with no
expiry date never qualifies, and one that has *already* expired is **expired**,
not expiring — it has its own status and must not read as a caution about
something yet to happen.

A voucher expiring **today** is expiring soon, not expired: it is redeemable all
day. That boundary is why the comparison is `>=` today rather than `>`.

There is exactly **one** definition, deliberately. It is stated twice — the
dashboard counter derives it in the Worker, the detail-view flag derives it in
the browser — and the two are matched down to the boundary. A page that counted
"3 vouchers expiring in the next 30 days" and then showed a voucher inside that
window without the flag would undermine both numbers, so the window moves in
both places or neither.

*Avoid*: "expiring", "nearly expired", "due" when you mean this. The dashboard,
the detail flag and this glossary all read *expiring soon*.

## Voucher hub build version

Terms describing how the hub identifies itself. Implemented in
`vouchers/scripts/version.mjs` and generated by `.github/workflows/pages.yml`.

### Build version

The identity of one published build of the voucher hub: a **count** of commits
touching `vouchers/`, the short commit **SHA**, and the **build timestamp**.
Generated at deploy time into `vouchers/version.json`, which is gitignored and
exists only inside the deploy artifact.

The count is the version — there is no `major.minor` and nothing is hand-typed,
because every hand-maintained version at UJ has drifted from what is deployed.
It is scoped to `vouchers/`, so it moves when the hub moves and stays put when
the roster or the HVT copy changes. See
[ADR 0004](docs/adr/0004-voucher-hub-build-version.md).

It renders in the hub footer beside the signed-in email, as
`v67 · 32ef795 · 7 Aug 18:41`, formatted by `vouchers/version-display.js` in
Perth time. **That fetch is `no-store`, and this is the point rather than a
precaution**: `version.json` sits on the same static origin as the HTML, so a
cached copy would name the previous build as the current one — announcing the
page is fresh at exactly the moment it is stale.

Because that fetch always reaches the origin, the footer states **what is
deployed, not what is running**. A browser serving a cached hub page prints the
current version beside stale code. Telling those apart needs a second version
carried by the page itself, which is
[vouchers#66](https://github.com/urbanjungleirc/vouchers/issues/66).

*Avoid*: "release" and "semver". The count orders builds; it claims nothing
about compatibility, and nobody chooses it.

### dev version

The value the generator emits when it cannot get a trustworthy answer from git
— no `.git`, no git binary, a shallow clone, or a malformed reply:
`{ version: 'dev', sha: '' }`.

It is deliberately obviously-fake rather than an error, because the generator
runs on the deploy path and must never be able to stop the site publishing. A
plain checkout has no `version.json` at all, so anything reading it must treat
missing and `dev` alike as "no version" — that is the normal state during local
development, not a fault.

## Clubworx pacing

Terms for talking to the Clubworx API without being cut off. Measured in
[staff-site#51](https://github.com/urbanjungleirc/staff-site/issues/51); evidence
in `cloudflare-clubworx/probes/51-events-and-burst.md`.

### Rate ceiling

The point at which Clubworx starts returning **429**. It is undocumented and,
unlike most APIs, **unadvertised**: no `Retry-After`, no `X-RateLimit-*`, not
even on the 429 itself. A client cannot read it, cannot see it approaching, and
cannot be told when it lifts — it can only measure it.

Measured: spent faster than ~3 requests/second, roughly **50 requests** get
through, after which the API refuses for about **18 seconds**.

Say *ceiling* rather than "rate limit" when referring to the observed boundary,
because "the rate limit" implies a published figure and there is none.

### Pacing

The gap a client deliberately leaves between Clubworx requests. **75 requests
per minute, one in flight, 800ms apart** is the house figure — verified to run a
full 90-read lookup clean, twice, with margin left over.

Pacing is the control, not concurrency. Requests in flight change only how fast
the ceiling arrives, never how much is allowed: four concurrent reached it
*sooner* than one and then failed 41 requests in a row.

The margin exists for other systems, not this one. There is **one Clubworx key
for the whole gym** (see `cloudflare-clubworx/ACCESS.md`), so HVT's roster
Worker, n8n and staff-site all spend the same allowance. A run here can throttle
something unrelated, with nothing in either system's logs to explain it.

## Clubworx school marking

### School marker

The plus-addressed email a school-created contact carries —
`noreply+<school>@urbanjungleirc.com`. It is the **only** provenance signal this
system has: Clubworx issues one API key per gym, so a contact cannot be
attributed to the tool that made it, and the address is the substitute.

The **tag** is the `<school>` part inside it. The marker is the whole address;
the tag is what distinguishes one school from another, and it is what
`GET /api/clubworx/schools` returns (#67). *Slug* is a synonym in circulation —
the design spec §4 uses it — but `tag` is the term here and in the code.

Verified against writes in #49, not inferred: Clubworx accepts the `+`, stores
the tag unchanged, partial-matches `noreply%2B` to find every marked contact, and
returns exactly one school's contacts for a full tag. See
`cloudflare-clubworx/probes/49-plus-addressed-duplicates.md`.

### Shared email

Two or more contacts holding the same address. **Clubworx permits it** — email is
not unique per contact — which is what makes the marker workable at all, because
siblings arrive on one parent's address and a whole school shares one
`noreply+<school>@`.

It also means an email can never identify a person here. Identity is surname plus
date of birth (#46); the address identifies a *school*.

### Contact status endpoints

`/prospects`, `/members` and `/non_attending_contacts` are three disjoint views
by status, not three indexes over one table. A contact created as a prospect
appears in `/prospects` **only**, and moves when their status changes.

So a lookup searches all three and merges. Which one holds a given student is a
fact about their membership today, not about how they were created.

That lookup is `cloudflare-clubworx/src/contacts.js`, behind
`GET /api/clubworx/contacts?last_name=&dob=` (#68). It narrows and merges;
deciding the match is `school-booking/identity.js`. It **refuses** rather than
answering short — a failed view, an unreadable body or a query that never
narrowed all return an error, because an empty candidate set is read as `new`,
and `new` writes a contact Clubworx cannot delete.

## Clubworx school booking

Terms for the route a student takes into a session. Decided 2026-08-18, after
#50 showed the original prospect route does not work.

### School Session

The Clubworx **event type** for a school group's session. It accepts only
contacts holding an active [School Pass](#school-pass), its capacity is set for
the group, and it requires booking **at least one day ahead** — a deliberate
guard against somebody booking themselves in on the day.

*Avoid*: "school booking" as the event type's name. "Booking" already means the
API object, the staff action, and the thing a School Pass grants; a fourth
meaning is one too many.

### School Pass

The **membership plan** every imported student is given, valid **26 weeks** —
long enough to cover a UJ [term](#uj-term-week) including its snapped edges *and*
the lead time the booking is made with. It is what makes a student bookable: a
School Session admits pass-holders and nobody else.

It ran 12 weeks until 2026-08-20, which covered the term but not a term booked
three or four weeks ahead of its first session. See
[ADR 0005](docs/adr/0005-school-pass-runs-26-weeks.md) — and do not shorten it
back, which is what that ADR exists to say.

Deliberately a different noun from School Session. A *session* happens on a
date; a *pass* is held by a person. The pair was otherwise easy to confuse in a
dropdown or a sentence.

The plan name is **never** renamed per student. Reporting aggregates by plan, so
per-student names would fragment member counts and revenue; the school is
already recorded by the [school marker](#school-marker) and the term is implied
by the membership's `start_date`. The duration stays out of the name because
`GET /membership_plans` exposes `membership_duration` already.

Proven end to end in #60: a member holding an active pass books, and the pass
costs nothing and starts no billing schedule.

### Active pass

Whether a School Pass admits its holder *today*. A membership record carries
`start_date` and `expiration_date` and **no `status` field**, so this is derived
from the dates — inclusive at both ends, since a pass starting today is usable
today. Code that looks for `status` reads `undefined` and would treat a live
pass as inactive.

*Avoid*: "has a School Pass" as a synonym. Holding the plan and holding an
**active** one are different: an expired pass is still a returned row, and the
session admits only the active kind.

*Avoid*: treating it as the test for whether a student can be booked into a
**term**. That is a [covering pass](#covering-pass), and it is a different
question.

### Covering pass

Whether a School Pass admits its holder on **the last session of the run** — not
today. `expiration_date` against the latest selected session date, inclusive.

This is the test the write chain uses, because *active today* is exactly the
answer that hid the problem [ADR 0005](docs/adr/0005-school-pass-runs-26-weeks.md)
was written about: every booking is made on the day of the run, when any pass
granted that day is unambiguously active, and the shortfall only shows up weeks
later at a session nobody is looking at.

The distinction bites hardest on a **returning student**. At 26 weeks the tool
will regularly find someone holding a pass that is active but expires mid-term —
a case a 12-week pass mostly turned into a clean "expired, grant a new one".
Granting the covering pass then means granting a **second** pass to a live
holder, which is the one thing on this effort deliberately never probed
([#90](https://github.com/urbanjungleirc/staff-site/issues/90)), because
memberships have no delete.

*Avoid*: hard-coding the 26 weeks to compute it. For a held pass, read
`expiration_date`; for a pass not yet granted, read `membership_duration` off the
plan. The number lives in Clubworx.

### Reversible write

The one thing this system does that can be taken back: a **booking**.
`DELETE /api/v2/bookings/:id` removes one, verified in #60 by re-reading rather
than by its status code — and it needs `contact_key` alongside `account_key`,
form-encoded in the body.

Nothing else qualifies. A contact cannot be deleted, and a School Pass has no
delete endpoint at all — it lapses at its `expiration_date`. So "undo" can
unbook and can never uncreate, and any UI implying otherwise is lying.

### Prospect allowance

Clubworx's per-**contact** limit on how many events a prospect may be booked
into. It is the reason the prospect route failed: the limit is reached
immediately for a returning student, the override exists **only in the Clubworx
UI**, and the API reports hitting it as *"this class has no free spaces
available"* — pointing at event capacity, which the same API reports as healthy.

Not exposed by any endpoint. Measured in
`cloudflare-clubworx/probes/50-membership-less-booking.md`.

*Avoid*: reading a "no free spaces" refusal as a capacity problem without
checking `spaces_available` first. The two are indistinguishable from the
message alone.

## Clubworx school list parsing

Terms for turning a school's pasted list into rows. Decided 2026-08-18 on #52,
against the three real lists catalogued in #48.

### Vertical list

A paste carrying **one field per line**, several lines per student, rather than
one record per line. One of the three real lists is shaped this way, and a
row-per-line parser reads it as **126 students out of 21** without erroring — so
this is a first-class branch decided before any field splitting, not a fallback.

*Avoid*: "column list" or "single-column". Both read as *one field of data*,
which is a different thing entirely.

### DOB anchor

The rule that the date is identified by the **shape of its values**, never by
its position or its header text — and that this identification is what validates
both the layout and the column mapping. In a genuine vertical list exactly one
*position within the repeating block* is date-shaped in every block; in a
horizontal list exactly one *column* is. Neither holding is a refusal, not a
guess.

The date is the only one of the three fields whose identity is readable from its
own contents, which is what makes it load-bearing.

*Avoid*: the divisibility rule as first written on #48 — "no tab or comma, and a
line count that is an exact multiple". All three fixtures are CRLF and the
vertical one opens with a blank line, so its 37 lines are not a multiple of 6
while its 36 non-blank lines are; and almost any line count divides by 2 or 3
anyway.

### Date orientation

Whether a list reads `d/m/yyyy` or `m/d/yyyy` — a property of the **whole list**,
inferred once from every date in it and applied to all rows. One field above 12
proves it; contradictory evidence within one list refuses the paste; a wholly
ambiguous list asks, showing a real date read both ways.

Never defaulted silently. A wrong orientation does not error — it turns March
into May, reports the student not-found, and creates a permanent contact with a
wrong DOB that then poisons the surname + DOB identity key for every later term.

Students are all born this century, so a two-digit year is `20xx` and a parsed
DOB **before 2000 is not a student** — a sharper teacher-row detector than
guessing at names.

*Avoid*: "date format". *Format* implies a per-value property, which is exactly
the mistake this term exists to prevent.

### Count gate

The expected student count, typed by staff **before** the parse result is shown
and checked against it. A mismatch blocks the run.

The order matters: a count displayed first is anchoring theatre, since nobody
disagrees with a number already on screen. It is the only single check that
catches layout misdetection, junk absorbed as students, a truncated paste and
phantom trailing columns at once.

*Avoid*: "validation". It is a gate — a mismatch stops the run.

### Junk line / Unparseable row

Different things, separated by **position**. A *junk line* holds no date-shaped
value, has a field count unlike the modal one, and sits **before the first
successfully parsed record** — a school title, a prose sentence, a header. It is
ignored, with the count always on screen.

Anything that fails to parse **after** the first good record is an *unparseable
row*, and it **blocks Apply** until corrected or explicitly dismissed. That is
where a real student hides.

*Avoid*: "bad row" for both. The position is the entire distinction, and
collapsing it is how a student silently disappears.

### Write form / compare form

The two normalisations of a name, deliberately different.

*Write form* is what is stored in Clubworx: trimmed, internal whitespace runs
collapsed, NBSP → space, curly apostrophe → `'`, non-breaking hyphen → `-`,
zero-width characters and BOM stripped, Unicode NFC. Case is never touched and
accents are never stripped.

*Compare form* is used only for matching and in-paste dedup: additionally
case-folded, with apostrophes, hyphens and spaces removed, and **Latin accents
folded** — `Fernández` matches `Fernandez` (#80).

Precisely: a combining mark (U+0300–U+036F) is dropped **only when it sits on a
Latin base letter**. Two narrowings, both because a false match is the worse
failure — it attaches a pass and bookings to the wrong child, where a miss only
creates a duplicate contact:

- **Not all of `\p{M}`.** In an abugida the vowel signs are marks too, so the
  wider rule deletes letters rather than accents — `प्रिया` becomes `परय`.
- **Not marks on a non-Latin base.** The combining-diacritics block is
  script-neutral; ungated it folds Cyrillic `й` onto `и` and `ё` onto `е`, which
  are separate letters of that alphabet. `Андрей` and `Андреи` are two names.

Two limits worth knowing, both deliberate:

- **Vietnamese folds**, because it is Latin script: `Lê`, `Lệ` and `Lễ` share one
  compare form. Accepted, since this is the case #80 was filed about, and a false
  match needs the surname, birthday and first name to coincide as well.
- **A letter carrying its stroke inside itself never folds**, because it does not
  decompose: `Wałęsa` matches `Wałesa`, not `Walesa`. Reaching those needs a
  transliteration table, not mark-stripping — #83.

The split is load-bearing — it is what lets `O'Brien` match `OBrien`, and
`Fernandez` match `Fernández`, without ever *writing* the second spelling into a
record that cannot be deleted.

*Avoid*: "normalised name" unqualified. Which one is meant decides whether a
permanent record is altered.

### Preferred name

A first name that is a **nickname rather than the legal name**, as shipped by a
school system column headed `PreferredName`. One of the three real lists has
one.

A first-name mismatch against Clubworx is therefore an *expected* outcome of a
correct match, not evidence of a wrong one — which weakens the first-name
tie-breaker in the identity rule precisely where it is needed, for twins.

*Avoid*: treating it as the first name. The tie-breaker depends on telling them
apart.

### Ignored column

A column present in the paste and deliberately not read — form group, year
level, student email. **Always named on screen** ("3 columns ignored:
FormGroup, YearLevel, Email"), because that line costs nothing and is the tell
that the mapping went wrong.

*Avoid*: "extra column". Naming what is ignored is the point.

### Parse-time row state

What the parser produces before any API call: `clean`, `needs-confirmation`,
`error`, `ignored`.

Distinct from the **match** states — `new`, `matched`, `name variant`,
`ambiguous`, `already booked` — which all require a Clubworx read and belong to
the review table.

`unmatchable` joined the match states on #65: a row missing either half of the
identity key — **surname or DOB** — concludes nothing, however many candidates
come back. It is not an error state and not `new`. Calling such a row `new` is
what creates a permanent contact with no DOB, which then poisons the surname +
DOB key for every later term; matching a surname-less row picks whichever contact
happens to share the birthday. The parser holds both shapes at
`needs-confirmation`, so this is the second line of defence, not the first.

*Avoid*: mixing the two lists. Only the first exists before a single request is
sent.

## Clubworx school booking runs

Terms for executing a list against Clubworx. Decided 2026-08-18 on #53, against
the behaviour measured in #50, #51 and #60.

### Run

One apply pass over one pasted list and one event selection. Browser-driven, one
Worker call per student, students processed in list order.

A run is not free: 25 students across 6 events is roughly **300 requests and
four minutes** at the mandated 75 req/min, and the rate allowance is gym-wide —
the roster and n8n spend it unseen. A re-run where nothing needs doing still
costs most of that.

### Write chain

The three writes that place one student: **contact → School Pass → booking**.
Only the last is a [reversible write](#reversible-write).

The chain is **all-or-nothing per student**: any failure abandons that student
and rolls back the bookings this run made for them, so a student is in every
session or in none — never half-booked.

*Avoid*: reasoning about the three writes as if they were one transaction. Two
of them cannot be undone.

### Stranded student

A student left **between** the writes — most often a permanent contact and an
active School Pass with no bookings. Under the all-or-nothing rule this is the
*guaranteed* outcome of an abandoned student, not an edge case, so the result
table names it explicitly and staff finish it by hand.

*Avoid*: counting a stranded student as a plain failure. Two irreversible
records now exist for them.

### Row outcome

The controlled vocabulary of per-row results: `created`, `matched`,
`pass assigned`, `pass already held`, `booked`, `already booked`, `refused`,
`unknown`.

**`already booked` is a success**, not an error. Clubworx refuses a duplicate
itself — *"Woops! You've already booked into this class!"* — which is the
idempotency guarantee showing up, and is what makes a re-run safe.

The distinction between `booked` and `already booked` is a **safety interlock**,
not a display detail. Cancellation and automatic rollback act on `booked` only;
acting on the whole row set would delete bookings this run never made, possibly
a session a real member booked themselves.

*Avoid*: styling `already booked` as a failure, and collapsing it into `booked`.

### Call outcome

The controlled vocabulary of whole-**call** results, distinct from the per-row
[row outcome](#row-outcome) above. `POST /student` answers `complete`,
`abandoned`, `unverified` or `refused`; `POST /unbook` answers `cancelled`,
`partial`, `nothing-to-cancel`, `still-booked`, `unverified`, `failed` or
`refused`.

**`unverified` is not a synonym for `failed`.** It means the write or the cancel
was accepted and could not be confirmed by re-reading — a throttled or truncated
verifying read. The two send an operator to different places: `failed` means do
it again, `unverified` means go and look in Clubworx first.

*Avoid*: mapping a call outcome onto an HTTP status alone. Only a throttle that
changed nothing and a refusal before any write leave as a non-200 — everything
else is a `200` carrying the record, because the record is the thing that cannot
be recreated.

### Restart-safe re-run

The recovery mechanism: re-paste the same list, pick the same sessions, run
again. Every write is safe to repeat — the contact via the dedup search across
all three [status endpoints](#contact-status-endpoints), the membership via a
read before assigning to a matched contact, the booking because Clubworx refuses
the duplicate.

No run identity, no stored progress, and no student names at rest in Cloudflare.

*Avoid*: "resume". It implies stored state this design deliberately does not
keep.

### Lead time

The **one-day minimum** between booking and a School Session starting,
server-enforced and knowable client-side from the event start. A selected event
inside it hard-stops the run before any write.

Staff must never meet Clubworx's own message here — *"Sorry! This class is now
closed for bookings."* — which names no cause and reads like a capacity problem.

### Unknown refusal

A `400` whose message matches none of the three known strings — prospect
allowance, lead time, already-booked. All refusals arrive as `400` with
`{"error": "..."}`, so **the message string is the only discriminator**.

An unknown one is shown **verbatim** and attributed to Clubworx, never retried,
never re-worded, and counted toward the run halt.

*Avoid*: paraphrasing it. A paraphrase is what makes new Clubworx behaviour
invisible — #50 is the cautionary tale, where a truthful-sounding message
pointed at entirely the wrong mechanism and cost an architectural route.

### Run halt

Stopping a whole run after **three consecutive failures**, or on a `429` that
survives backoff. Distinct from a single row failing.

One row failing is data; a run of failures is a systemic condition — and the
measured throttle failure mode is not scattered rows but the entire back half of
the list (49 successes, then 41 consecutive `429`s).

## School booking page

Terms for the page shape. Decided 2026-08-18 on #54 against three built
prototypes, and settled by the spec on #55.

### Gated stepper

The page's shape: **one screen per step, each gate a screen you cannot skip** —
school, paste, rows, sessions, preview, result. Chosen over a two-pane cockpit
and a single scrolling form.

Its defining property is that the gates are **worked, not acknowledged**.
Resolving an exception does real work, so gates visibly clear as they are
cleared and Apply lights up when the last one goes.

*Avoid*: "wizard". A wizard walks you through something that would otherwise
work; these steps exist because the run must **not** start while anything is
unresolved.

### Inline row resolution

An exception row **expanding in place** to offer its fix, rather than opening a
second pane or a modal. A single-column stepper has nowhere to put a detail
panel, and a modal would be a gate inside a gate.

Available on **both** the Rows step and the Preview step, which is not symmetry
for its own sake: [parse-time states](#parse-time-row-state) exist from step 3,
but match states only exist after the Clubworx check between steps 4 and 5.
Either surface alone leaves half the exceptions unreachable.

Dismissing a row **reclassifies** it to `ignored` and never removes it — the
[P1 reconciliation](#junk-line--unparseable-row) is asserted after a dismissal,
not only after a parse.

*Avoid*: "edit mode". Nothing here is a general editor; each control answers one
specific refusal the tool has already made.

### Permanence line

The sentence above the preview table stating what the run is about to create,
with the irreversible parts named as such — *"This will create 4 contacts
(permanent) and 4 School Passes (permanent), and make 34 bookings
(cancellable)."*

It is **the same line in two tenses**: future before Apply, past after, since
the preview table becomes the result table. The per-row version of the sentence
lives inside the [expanded row](#inline-row-resolution), not in a column.

*Avoid*: folding it into a success count. The three permanence classes are the
whole point — collapsing "created" and "booked" into "done" hides which half can
be taken back.
