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
