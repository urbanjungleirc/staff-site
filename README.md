# Urban Jungle Staff Site

This repository hosts the Urban Jungle staff tools hub. The root `index.html` renders a simple directory of internal tools sourced from `tools.json`, and each tool can live in its own subdirectory (for example `hvt/`) or as a standalone page in the project root.

## Access Control

The site is intended for Urban Jungle team members only. Access is enforced through Cloudflare Zero Trust; make sure the final deployment domain is protected by the appropriate Zero Trust application policy before sharing the link.

## Managing Tools

- Update `tools.json` to add, edit, re-order, or remove entries. The file exposes a single `entries` array; items render in the same order they are listed.
- To surface a standalone tool, create an entry with `"type": "tool"` plus at least `name` and `path`. Optional keys like `description`, `category`, and `status` enrich the card.
- To group related static pages, create an entry with `"type": "group"`, supply a `name`/`description`, and populate the `items` array. Each item requires a `path` and can define `buttonText` to control the button label that appears on the hub.
- Create a matching directory or file for every `path` you register. Static assets for a tool should live alongside its entry (e.g. `/hvt/index.html`).

## Staff Roster (`roster.html`)

`roster.html` is a real-time daily roster display designed for a shared screen in the gym. It fetches shift data directly from the **When I Work** ICS subscription feed (via the Cloudflare Worker proxy) and renders it as a timeline or grouped view.

### How it works

```text
Browser → ujstaff.happyk.au/api/ics → Cloudflare Worker → When I Work ICS feed
```

The Worker fetches the full ICS feed (≈ 2 weeks of shifts) and returns it to the page. The page caches it in memory — navigating between days is instant and only actual auto-refresh hits the network.

### First-time setup

#### 1. Add the ICS secret to the Cloudflare Worker

Get your ICS subscription URL from When I Work:
`My Schedule → Export / Subscribe → Copy ICS subscription link`

Then set it as a Worker secret:

```bash
cd cloudflare-worker
echo "https://app.wheniwork.com/calendar/.../global.ics" | npx wrangler secret put ICS_URL
npx wrangler deploy
```

#### 2. Add the Worker route in Cloudflare dashboard

The Worker must intercept `/api/*` requests before they reach GitHub Pages.

- Dashboard → Workers & Pages → `uj-tools-editor` → Settings → Triggers → Routes → Add route
- Pattern: `ujstaff.happyk.au/api/*` · Zone: `happyk.au`

This also enables the `/api/tools.json` admin editor endpoint.

### Configuration

All settings are at the top of `roster.html` in the `CONFIG` block:

| Setting | Default | Description |
| --- | --- | --- |
| `icsProxyUrl` | `/api/ics` | Worker endpoint — auto-switches to `localhost:8787` for local dev |
| `dayWindowDays` | `7` | Fallback nav range (days either side of today) used before the ICS loads; once loaded, the range is derived from the actual dates in the feed |
| `refreshIntervalMs` | `30 min` | How often the ICS feed is silently re-fetched in the background |
| `roleOrder` | `MOD, FOH, COACH, SETTING, ADMIN` | Display order of role sections; anything else falls into "Other" |
| `roleLabels` | see file | Friendly heading text shown for each role key |
| `roleMap` | see below | Maps raw role names from WIW to a display group (case-insensitive) |

### Adding or renaming roles

When I Work shift titles follow the format: `Name (Shift as ROLE at UJ)`

- To display a new role in its own section: add its key to `roleOrder` and a label to `roleLabels`.
- To merge a role into an existing section: add an entry to `roleMap` (keys are uppercase, matched case-insensitively).
- Anything not listed in `roleOrder` or `roleMap` automatically appears under **Other**.

Current `roleMap` defaults:

| Raw WIW role | Displayed under |
| --- | --- |
| `JUNIOR` | FOH |
| `WORK EXPERIENCE` | FOH |
| `SHIFT SUPERVISOR` | MOD |
| `STRIPPING` | SETTING |
| `HOLIDAY` | ADMIN |
| `PH` | ADMIN |

### Local development

```bash
# 1. Create the secrets file for local worker
echo 'ICS_URL="https://app.wheniwork.com/calendar/.../global.ics"' > cloudflare-worker/.dev.vars

# 2. Start the local worker (http://localhost:8787)
cd cloudflare-worker && npx wrangler dev

# 3. Serve the site root (any static server)
npx serve .
# then open http://localhost:PORT/roster.html
```

The `CONFIG.icsProxyUrl` auto-detects `localhost` and points to `http://localhost:8787/api/ics` — no manual changes needed.

### Behaviour notes

- **Inactivity reset**: if the page is left on a non-today date for 25 minutes with no interaction, it silently returns to today.
- **Auto-refresh**: every 5 minutes the ICS is re-fetched in the background without any loading flash.
- **Default view**: Timeline. Users can switch to Grouped view; the choice persists until the page is reloaded.

## Local Preview

Any static file server (such as `python3 -m http.server` or `npx serve`) can be used to preview locally. Launch the server from the repository root so `index.html` and subdirectory assets are available at the expected paths.

## Voucher Portal (`vouchers/`)

The voucher management portal lives at `ujstaff.happyk.au/vouchers/`. It connects to the `uj-payments` Cloudflare Worker using a shared staff secret for API authentication.

### First-time setup (per browser / per device)

The portal uses a URL-hash seeding approach so staff never see a login screen. The secret is stored in `localStorage` after the first visit and never prompts again. the secret is: d60d61624f016b78e84c2caf04980e53

**Step 1 — get the setup URL** (from the password manager entry "UJ Staff Voucher Secret"):

```
https://ujstaff.happyk.au/vouchers/#<STAFF_SHARED_SECRET>
```

**Step 2 — open that URL in the browser.** The page loads normally, stores the secret in `localStorage`, and strips the hash from the address bar automatically.

**Step 3 — bookmark `https://ujstaff.happyk.au/vouchers/`** (without the hash) for everyday use.

After step 2 the hash URL is no longer needed. If a device is reset or `localStorage` is cleared, repeat step 2.

### Local development

The `uj-payments` Worker allows any `localhost` or `127.0.0.1` origin so any port works locally. To test with a real secret, visit:

```
http://127.0.0.1:<port>/vouchers/#<STAFF_SHARED_SECRET>
```

The `STAFF_SHARED_SECRET` value is in the team password manager under "UJ Staff Voucher Secret".

---

## Deployment

Deploy the contents of this repository to your static hosting provider (e.g. GitHub Pages, Cloudflare Pages, or S3). Re-run your Cloudflare Zero Trust checks after deployment to confirm only authenticated staff can reach the hub.
