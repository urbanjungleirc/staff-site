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
                          log line. Only GET /api/clubworx/health so far (#66); the
                          working routes arrive with #67/#68/#70.
cloudflare-clubworx/src/ - the Worker. request.js and errors.js were moved here
                          from probes/lib/ by #66 and the probes import them back.
cloudflare-clubworx/probes/ - read-only probes against the live Clubworx API, and
                          what they found. Start with probes/README.md — it carries
                          the rules (no production data recorded, pace under
                          75 req/min) that any new probe has to follow.
school-booking/parse.js - turns a pasted school student list into rows plus the
                          list-level inferences (layout, column mapping, date
                          orientation). Pure and unit tested; §7 of the design
                          spec. Nothing imports it yet — see #64/#71.
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
