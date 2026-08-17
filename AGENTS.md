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
cloudflare-clubworx/    - Clubworx API access for the school-group booking tool (#46).
                          ACCESS.md is the answer to #47: where the key comes from,
                          where it lives, and what is still owed. No Worker code yet.
hvt/                    - High-volume Training tool copy
slideshow/              - Google Drive TV slideshow tool
sls_tv.html             - Summer Lead Series TV display
liverumble*.html        - Rumble in the Jungle pages
livescore_ssp*.html     - Super Social Pumpfest scoring/result pages
iFrameTestBookingCalendar.html - booking calendar embed test
vouchers/scripts/version.mjs - derives the hub's build version from git at deploy time (unit tested)
vouchers/version-display.js - formats that version for the footer, in Perth time (unit tested)
.github/workflows/pages.yml - publishes the site to Pages; the repo's only build step
```

There is also a separate `slideshow/AGENTS.md` for the slideshow tool. This root file describes the overall staff-site repo.

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
It is present in all three view modes.

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
and must be extended before then; the UI warns as it approaches expiry. Public
holidays are not implemented yet — `publicHoliday` is always `null`.

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

The two Workers deploy separately; a Pages publish does not touch them.

```bash
cd cloudflare-worker          # roster + tools.json API
npx wrangler deploy

cd cloudflare-payments-proxy  # voucher portal → uj-payments; happyk account
npx wrangler deploy
```

## Safety Notes

- Do not commit `.wrangler/`, local deployment backups, or test deployment folders.
- Do not commit `.dev.vars` or any real API tokens.
- `tools.json` is user-facing through the hub, so validate links after editing it.
- Roster staff data comes from Deputy; avoid hard-coding staff names in `roster.html`.

## Agent skills

Shared configuration for the engineering skills — mirrored from `CLAUDE.md`, which is authoritative.

- **Issue tracker** — GitHub Issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.
- **Triage labels** — default canonical vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.
- **Domain docs** — single-context layout (`CONTEXT.md` + `docs/adr/` at repo root). See `docs/agents/domain.md`.
