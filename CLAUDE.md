# staff-site - Urban Jungle Staff Tools Hub

Internal tools hub for Urban Jungle staff. The site is served as static HTML and protected by Cloudflare Zero Trust.

## Live URL

`ujstaff.happyk.au`

Access is for Urban Jungle staff only. Keep the Cloudflare Zero Trust application policy active before sharing links.

## Repository Structure

```text
index.html              - hub homepage; renders cards/groups from tools.json
tools.json              - source of truth for hub entries
roster.html             - daily staff roster, pulled from Deputy via Cloudflare Worker
cloudflare-worker/      - Worker for roster API and tools.json editor API
cloudflare-payments-proxy/ - Worker bridging vouchers/ to uj-payments with the Access JWT
cloudflare-clubworx/    - uj-clubworx-api, the Worker for the school-group booking
                          tool (#46). Deploys separately from Pages. Start with its
                          README.md; ACCESS.md is the answer to #47 (where the key
                          comes from and where it lives). Verifies the Access JWT
                          rather than trusting the header, paces at 75 req/min, and
                          stores nothing — no student name or DOB in any store or
                          log line. Every route the design names is built:
                          GET /api/clubworx/health (#66),
                          GET /api/clubworx/contacts (#68),
                          POST /api/clubworx/student (#69), the three reads
                          GET /api/clubworx/{events,plan,schools} (#67) and
                          POST /api/clubworx/unbook (#70).
cloudflare-clubworx/src/contacts.js - the dedup read. Searches all three disjoint
                          status views and merges, because a contact moves between
                          them (#49). Every uncertain answer is a refusal: an
                          empty candidate set means "new", and "new" writes a
                          contact Clubworx cannot delete.
cloudflare-clubworx/src/events.js - the event picker's read, the 24-hour lead
                          time (defined here, imported by student.js) and the
                          paste-an-id lookup. It ANNOTATES and never filters:
                          a session missing from the picker is invisible, where
                          one greyed out with its reason is a human decision.
                          GET /events/:id is MEASURED and DEAD: it answers 404
                          for every id, real or invented (#97). resolveEvent
                          stays as an honest refusal; the page resolves a pasted
                          id itself, out of the window it already holds (#72).
cloudflare-clubworx/src/paging.js - walking a Clubworx list when the response
                          carries no total, no next-page link and no header. A
                          full page is unfinished, never an answer; what the
                          ceiling MEANS is the caller's to decide, because on
                          /plan it is a refusal and on /events it is a flag.
cloudflare-clubworx/src/plans.js - name -> membership_plan_id, the plan's
                          membership_duration, and `coverage_end` — the last day
                          a pass granted today still covers. #60 saw 50 of 57
                          plans come back with School Pass among the missing, so
                          a full page is "truncated", never "no such plan"; a
                          duplicate name is refused rather than guessed. The
                          number 26 lives in Clubworx, not here (ADR 0005), and
                          `coverage_end` is computed here rather than in the
                          browser so the calendar arithmetic has one home.
cloudflare-clubworx/src/schools.js - the distinct School marker tags, across
                          all three status views. Returns tags and counts, never
                          contacts. A tag missing here is a staff member typing
                          a second spelling of a school onto records that cannot
                          be deleted.
cloudflare-clubworx/src/student.js - the per-student write chain, and the ONLY
                          code here that creates permanent records. Contacts and
                          memberships have no delete, so every write is verified
                          by re-reading it, every retry re-reads first, and any
                          failure rolls back that student's bookings and names
                          them stranded. Read §10/§12 of the design spec first.
cloudflare-clubworx/src/bookings.js - book, cancel, and the error vocabulary.
                          Three refusals share HTTP 400 and the message string is
                          the only discriminator; "already booked" is a SUCCESS
                          and carries no booking id, which is what stops a
                          rollback reaching a booking this run did not create.
                          cancelRunBookings owns ALL FOUR cancel guarantees —
                          the interlock, contact_key-from-the-row, the halt on a
                          throttle, and confirming by re-read — because D3's
                          rollback needs every one of them and is not a route.
                          The re-read matches on the EVENT as well as the id: an
                          id-only check passes vacuously when a list row carries
                          a shape bookingIdOf does not know.
cloudflare-clubworx/src/unbook.js - the cancel route, and only the route's own
                          job: validate the body, refuse a set spanning two
                          students (one call cancels one student — a whole run
                          in one request is minutes long and loses its log), and
                          turn the tally into an outcome. Bookings are the ONLY
                          thing this system can take back; contacts and passes
                          have no delete at all, so a caller gets its bookings
                          back and nothing else and the UI must not imply more.
cloudflare-clubworx/src/memberships.js - is the held School Pass good enough? The
                          test is "covers the last selected session", never
                          "active today" (ADR 0005). A live-but-short pass
                          refuses rather than granting a second one to a live
                          holder — #90's open question.
cloudflare-clubworx/src/ - the Worker. request.js, errors.js,
                          summariseMemberships, findPlanByName, describeLeadTime
                          and pickBookableEvents were moved here from probes/lib/
                          by #66, #69 and #67, and the probes import them back.
cloudflare-clubworx/probes/ - read-only probes against the live Clubworx API, and
                          what they found. Start with probes/README.md — it carries
                          the rules (no production data recorded, pace under
                          75 req/min) that any new probe has to follow.
school-booking.html     - the school booking page, steps 1-5 (#71, #72): school,
                          paste + declare the count, the parse result with
                          inline row resolution, the session picker, and the
                          preview. Variant A of §9, decided on #54. NOT in
                          tools.json and unreachable from the hub until #46's
                          last step — §17's order, because `main` is production.
                          Step 6 (Apply, the run engine, the result table) is
                          #73; every route this page calls is a GET, and a
                          component test asserts that.
school-booking/events.js - what a SELECTION of sessions is: the same-name,
                          same-location pre-tick (no recurrence field exists,
                          so any automatic rule is a guess), the lead-time and
                          past-session hard-stops with D9's one-click removal,
                          and the spaces warning that never blocks.
                          sessionRefusal() is the ONE place deciding what is
                          wrong with a session and how serious — the blocker
                          list and the picker's row styling both ask it. Do not
                          read the Worker's `bookable` for this: it folds "no
                          room" in with "too close to the start", and only the
                          second refuses a booking, so reading it alone paints
                          a warnable session as a refused one.
                          The paste-an-id fallback resolves HERE, against the
                          window already on screen — GET /events/:id answers 404
                          for every id, real or invented (#97), so a message
                          built on it would tell staff a correct id is wrong.
school-booking/preview.js - step 5: the STUDENT/DOB/READ/CLUBWORX/OUTCOME table,
                          the match resolution log, the per-row consequence and
                          the aggregate permanence line, plus every hard-stop
                          that keeps Apply dark. It says only what it knows: the
                          membership is read at Apply (D14) and there is no
                          bookings read, so a matched row says "pass checked at
                          Apply" rather than "pass already active". An absent
                          answer is `pending`, never `new` — `new` writes a
                          contact Clubworx cannot delete.
school-booking/parse.js - turns a pasted school student list into rows plus the
                          list-level inferences (layout, column mapping, date
                          orientation). Pure and unit tested; §7 of the design
                          spec. #71 added the layout and column OVERRIDES the
                          page's affordances need — obeyed literally, including
                          where the inference was right, because an override
                          the parser may discard is not an override.
school-booking/steps.js - the gates of steps 1-3: the school tag and its
                          permanent marker, the count declaration (P5), and one
                          review() turning a parse plus a log of staff
                          resolutions into rows, the P1 reconciliation and the
                          blockers. Nothing it returns is ever a function —
                          that is what makes §16's `x-show="b.fix"` bug
                          unreachable, and a test asserts it. P1 is re-asserted
                          after every dismissal, not only after a parse.
school-booking/test/alpine-bindings.test.js - reads school-booking.html and
                          fails on any Alpine directive naming a function
                          without calling it (#78). A text check, because the
                          fault is a property of the text: it is not a logic
                          fault, so a unit test cannot see it, and it throws
                          nothing, so runtime does not report it. It also walks
                          the page's whole ?v= import chain — every module, and
                          every sibling import inside them, at one version. The
                          walk replaced a hand-written list in #72, after
                          identity.js joined the chain carrying an unversioned
                          `./parse.js` that had been harmless only while no page
                          imported it.
school-booking/identity.js - the matching rule: surname + DOB narrows, first name
                          breaks ties, variance is surfaced never merged. §5 of
                          the design spec. Imports the two name forms from
                          parse.js rather than restating them — the header there
                          says what a second copy costs. Fetches nothing.
vouchers/               - voucher management portal (auth = Cloudflare Access)
vouchers/stats.html     - voucher analytics: revenue, liability, redemption, product mix
vouchers/unsubscribes.html - who is not receiving automatic voucher emails, and why
vouchers/unsubscribes-logic.js - pure suppression rules behind that page (unit tested)
vouchers/delete-logic.js - pure confirmation rules behind the hard-delete action (unit tested)
vouchers/type-surfaces.js - which voucher-type fields feed which output surface (unit tested)
vouchers/nav-menu.js    - what the header hamburger holds, and which section it is hiding (unit tested)
vouchers/expiry-flag.js - whether a voucher counts as "expiring soon" (unit tested)
vouchers/scripts/version.mjs - derives the hub's build version from git at deploy time (unit tested)
vouchers/version-display.js - formats that version for the footer, in Perth time (unit tested)
.github/workflows/pages.yml - publishes the site to Pages; the repo's only build step
hvt/                    - High-volume Training tool copy
slideshow/              - Google Drive TV slideshow tool
sls_tv.html             - Summer Lead Series TV display
liverumble*.html        - Rumble in the Jungle pages
livescore_ssp*.html     - Super Social Pumpfest scoring/result pages
iFrameTestBookingCalendar.html - booking calendar embed test
```

There is also a separate `slideshow/CLAUDE.md` for the slideshow tool. This root file describes the overall staff-site repo.

## Hub Entries

The hub is driven by `tools.json`.

- Use `type: "tool"` for a single direct link.
- Use `type: "group"` for a card containing multiple related links.
- Entries render in the order they appear in the `entries` array.
- Keep every local `path` backed by a real file or directory in this repo.
- External paths are allowed for Apps Script, Google Sheets, and public tool links.

The Cloudflare Worker also exposes `/api/tools.json` for an editor workflow. It reads/writes `tools.json` through the GitHub Contents API.

## Staff Roster

`roster.html` is the real-time roster view for staff. It now uses Deputy, not When I Work.

Current flow:

```text
Browser -> /api/roster -> Cloudflare Worker -> Deputy API
```

Local development flow:

```text
Browser -> http://localhost:8787/api/roster -> local Wrangler Worker -> Deputy API
```

The page supports:

- Cards view
- Timeline by role
- Timeline by name
- "On now" highlighting
- Deputy kiosk "Clock In" link
- Role colors for timeline bars
- Background refresh without flashing the page
- Automatic reset to today after inactivity on another date

### Roster Configuration

The main roster settings live in the `CONFIG` block near the top of the script in `roster.html`.

Important fields:

- `rosterUrl` - `/api/roster` in production, `localhost:8787/api/roster` in local/dev
- `calendarUrl` - `/api/calendar` in production; term week / school break context
- `dayWindowDays` - fallback date nav range before roster data loads
- `refreshIntervalMs` - background refresh interval
- `roleOrder` - display order for known role groups
- `roleLabels` - human-readable labels
- `roleMap` - maps Deputy area names to canonical role groups
- `roleColors` - timeline colors for role groups

Current role color intent:

```js
MOD:     '#bf360c'
FOH:     '#f56a00'
COACH:   '#7c3aed'
SETTING: '#2962ff'
ADMIN:   '#374151'
```

Keep these synced with Deputy area colors where practical. Green is reserved for the `on-now` state, so avoid using green for normal role colors.

### Roster Day Context

Under the day nav, `roster.html` shows one line describing the **selected**
date — `Term 3 · Week 3 of 10`, or `School holidays · Term 4 starts Mon 12 Oct`.
On a public holiday a badge goes in front of it, never instead of it:
`[PUBLIC HOLIDAY] Anzac Day · Term 2 · Wk 2 of 11`. It is present in all three
view modes.

The data comes from `/api/calendar`, a route deliberately separate from
`/api/roster` so a Deputy outage cannot remove term context. The Worker returns
a per-date map spanning −30/+90 days, so navigating dates is a lookup and never
a refetch. The two fetches are independent: either can fail without taking out
the other.

A **UJ term week** is a whole Mon–Sun week, snapped outward from the official WA
term dates. This deliberately deviates from education.wa.edu.au — read
`docs/adr/0002-uj-term-weeks-are-snapped.md` before touching the term table or
the snapping logic. Definitions are in `CONTEXT.md`.

The term table in `cloudflare-worker/src/calendar.js` is hardcoded through 2031
and must be extended before then; the UI warns as it approaches expiry.

Public holidays come from a live WA feed the Worker fetches and caches (the feed
sends no CORS headers, so the Worker is required, not a convenience). Read
`docs/adr/0001-hybrid-calendar-sourcing.md` before touching that path — it
records the three traps that fail *silently*: exclusive all-day end dates, the
required trailing slash on the feed URL, and the rule that holidays must never
be deduplicated by name.

The two halves fail independently. If the feed is unreachable the Worker serves
the last cached copy flagged stale, and if there is nothing cached it marks
holidays unavailable and still returns term context.

### Deputy Worker Configuration

The production Worker is configured in `cloudflare-worker/wrangler.toml`.

Required secrets:

```bash
cd cloudflare-worker
npx wrangler secret put DEPUTY_TOKEN
npx wrangler secret put GITHUB_TOKEN
```

Important Worker vars:

- `DEPUTY_URL` - Deputy API base URL
- `DEPUTY_WINDOW_PAST_DAYS` - days before today fetched from Deputy
- `DEPUTY_WINDOW_FUTURE_DAYS` - days after today fetched from Deputy
- `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_BRANCH`, `TOOLS_PATH` - used by `/api/tools.json`
- `ALLOWED_ORIGIN` - CORS origin for the staff site

The Worker still contains a legacy `/api/ics` route, but `roster.html` should use `/api/roster`.

## Voucher Portal Auth

`vouchers/` authenticates via Cloudflare Access — there is no shared secret in
normal use. The page calls `/api/payments/*` same-origin; Access injects a
signed `Cf-Access-Jwt-Assertion` header; `cloudflare-payments-proxy/` forwards
it to the `uj-payments` Worker, which verifies the signature against the
`happyk.cloudflareaccess.com` JWKS. The verified email is written to the audit
trail.

Two things to know before changing any of this:

- **Access runs in front of Workers routes on this zone.** That is what makes
  the proxy work despite `uj-payments` living in a *different* Cloudflare
  account. Weakening the Zero Trust app breaks voucher auth, not just page
  privacy.
- **The proxy allowlists paths** (`/v1/vouchers`, `/v1/voucher-types`,
  `/v1/staff/`). It must never relay `/v1/checkout/sessions`, or it becomes an
  open relay for creating Stripe sessions. It also forwards `X-Manager-Secret`,
  the second factor on cancel/restore.

`X-Staff-Secret` survives only for localhost dev and as a break-glass path. A
present-but-invalid JWT fails closed rather than falling back to it.

Deploy the proxy from the **happyk** Cloudflare account (it owns `happyk.au`):

```bash
cd cloudflare-payments-proxy
npx wrangler deploy      # route is declared in its wrangler.toml
```

### Deleting a voucher

The **Delete Permanently** button on the voucher detail panel is a *hard* delete
— the row leaves the database, along with the `purchase_tracking` row that
counts against the buyer's per-customer limit. Cancel (the outlined rose button
beside it) is the reversible one. They are deliberately styled differently:
solid versus outlined.

Three things about this are easy to break by accident:

- **The button is identity-gated, not password-gated.** On load the page calls
  `GET /v1/staff/me` and renders the button only when `can_delete` is true, so
  nobody is shown an action that can only 403. That is a *display* gate — the
  Worker re-checks the verified Access JWT against its `DELETE_ALLOWED_EMAILS`
  allowlist on every DELETE, and `canDelete` starts `false` so a failed identity
  call hides the button rather than exposing it.
- **The typed voucher code is the real second factor**, and is not decoration.
  The allowlist authenticates the *session*, which cannot tell one person from
  their unlocked laptop; typing the code is what the allowlist cannot supply.
- **401 and 403 must not be collapsed.** 401 is the staff gate (the Access
  session lapsed — reloading fixes it). 403 is the allowlist (the session is
  fine and reloading will never help). Showing "sign in again" for a 403 sends
  someone round a loop that cannot succeed.

The rules behind all of that live in `vouchers/delete-logic.js` — pure, unit
tested in `vouchers/test/delete-logic.test.js`, and published as
`window.deleteLogic` like the other extracted modules. Bump the `?v=` on its
import whenever its exports change.

A stale cached copy of that module is the one failure that would break the
typed-code check, the required-reason check and the disabled button
*simultaneously and silently*, so two things hold it closed: `openDelete()`
refuses to open the modal when an export is missing, and `submitDelete()`
re-checks before sending. The re-check is the load-bearing one — an Alpine
expression that throws leaves `:disabled` unapplied, so a broken
`canSubmitDelete` would *enable* the confirm button, and only a guard on the
submit path turns that back into "nothing happens".

Design: `docs/superpowers/specs/2026-08-05-voucher-hard-delete-design.md` in the
`voucher-app` hub repo.

## Local Development

Static pages can be served from the repository root with any simple static server.

Example:

```bash
npx serve .
```

For roster API testing, run the Worker locally:

```bash
cd cloudflare-worker
npx wrangler dev
```

Local Worker secrets can go in `cloudflare-worker/.dev.vars`. Do not commit real tokens.

## Deployment

> ⚠️ **`main` IS production.** GitHub Pages serves this repo to
> `ujstaff.happyk.au`, published by `.github/workflows/pages.yml` on every push
> to `main`. No approval gate: anything reaching `main` is live in a minute or
> two.
>
> **That includes merging a pull request.** There is no separate "deploy" step
> to hold back, so *merging is deploying*. If a change is not ready to be seen by
> staff — or a ticket says not to deploy yet — it must not reach `main`, on a
> branch or otherwise. Where deploy **order** matters (the voucher portal needs
> its Worker and migration live first), merge this repo **last**.

Static changes therefore publish either way — a direct push, or a merged PR:

```bash
git add <files>
git commit -m "description"
git push origin main
```

The workflow copies the repo to `_site/` (minus `.git` and `node_modules`),
generates `vouchers/version.json` from git, checks the staged site still
contains the hub, the roster and the HVT copy, and publishes. There is **no
build step for the pages themselves** — they are served exactly as committed.
The one generated file is the voucher hub's build version; see
[ADR 0004](docs/adr/0004-voucher-hub-build-version.md), which also carries the
switchover runbook and why the version is never committed.

A red workflow means the site stays on its **previous** build — frozen, not
broken. Confirm a deploy, and check the commit it built:

```bash
gh run list --workflow=pages.yml --repo urbanjungleirc/staff-site --limit 1
```

**Do not confirm it by fetching the page.** The zone sits behind Cloudflare
Access, so an unauthenticated request returns **HTTP 200 carrying the Access
login page**, not the file you asked for — a success status and a body that
never contains your change. Verifying content needs a real browser session.

The three Workers deploy separately; a Pages publish does not touch them.

```bash
cd cloudflare-worker          # roster + tools.json API
npx wrangler deploy

cd cloudflare-payments-proxy  # voucher portal → uj-payments; happyk account
npx wrangler deploy

cd cloudflare-clubworx        # school-group booking → Clubworx; happyk account
npx wrangler secret put CLUBWORX_ACCOUNT_KEY   # once per environment, not in git
npx wrangler deploy
```

## Safety Notes

- Do not commit `.wrangler/`, local deployment backups, or test deployment folders.
- Do not commit `.dev.vars` or any real API tokens.
- `tools.json` is user-facing through the hub, so validate links after editing it.
- Roster staff data comes from Deputy; avoid hard-coding staff names in `roster.html`.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical label vocabulary (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout (`CONTEXT.md` + `docs/adr/` at repo root). See `docs/agents/domain.md`.
