# Urban Jungle Staff Site

This repository hosts the Urban Jungle staff tools hub. The root `index.html` renders a simple directory of internal tools sourced from `tools.json`, and each tool can live in its own subdirectory (for example `hvt/`) or as a standalone page in the project root.

## Access Control

The site is intended for Urban Jungle team members only. Access is enforced through Cloudflare Zero Trust; make sure the final deployment domain is protected by the appropriate Zero Trust application policy before sharing the link.

Zero Trust is not just a doormat here — the voucher portal *authenticates* against it. Cloudflare Access runs in front of Workers routes on this zone, so a signed identity token reaches the API. Removing or loosening the Zero Trust application would not merely expose the pages; it would break voucher staff auth. See [Voucher Portal](#voucher-portal-vouchers).

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

The voucher management portal lives at `ujstaff.happyk.au/vouchers/`.

### Access — there is no setup

Sign in to `ujstaff.happyk.au` and open the portal. That's it. Cloudflare Zero
Trust *is* the login: there is no second password, no secret to paste, and
nothing to configure per browser or per device.

(This replaced a URL-hash seeding flow — `#<secret>` pasted once per device —
in July 2026. If you find that documented anywhere else, it is stale.)

### How it authenticates

```text
Browser  ──►  ujstaff.happyk.au/api/payments/*   (same-origin; Access authenticates)
              │  Access injects a signed Cf-Access-Jwt-Assertion header
              ▼
         uj-payments-proxy      (cloudflare-payments-proxy/, this repo)
              │  forwards the token verbatim; holds no secrets
              ▼
         uj-payments            (Worker, separate Cloudflare account)
                 verifies the JWT signature against the
                 happyk.cloudflareaccess.com JWKS
```

Because the token is verified server-side, the signed-in email is a trustworthy
audit fact — it is recorded against every redeem, undo, cancel, and restore.

The proxy is a ~50-line Worker in `cloudflare-payments-proxy/`. Deploy it with
`npx wrangler deploy` from that directory; its route
(`ujstaff.happyk.au/api/payments/*`) is declared in its `wrangler.toml`. It
must be deployed from the **happyk** Cloudflare account, which owns the
`happyk.au` zone — not the account that owns `uj-payments`.

### Local development

Localhost has no Cloudflare Access in front of it, so the page falls back to the
shared secret and calls the production Worker directly (which allows any
`localhost` / `127.0.0.1` origin):

```
http://127.0.0.1:<port>/vouchers/#<STAFF_SHARED_SECRET>
```

The `STAFF_SHARED_SECRET` value is in the team password manager under "UJ Staff
Voucher Secret". Never write it into this repo, which is public.

That same secret is the **break-glass path** if Access is ever misconfigured and
locks the portal out: call `uj-payments.urbanjungle.workers.dev` directly with an
`X-Staff-Secret` header, bypassing both Access and the proxy. It is no longer
used by staff in normal operation.

---

## Deployment

Deploy the contents of this repository to your static hosting provider (e.g. GitHub Pages, Cloudflare Pages, or S3). Re-run your Cloudflare Zero Trust checks after deployment to confirm only authenticated staff can reach the hub.
