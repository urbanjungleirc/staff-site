Cloudflare Worker: GitHub commit flow for tools.json
====================================================

This Worker provides a minimal API to read and update `tools.json` in your GitHub repo using the GitHub Contents API. The index page includes a lightweight editor that calls this API when `?admin` is present and `WORKER_API_BASE` is configured.

## Files

- `cloudflare-worker/wrangler.toml`
- `cloudflare-worker/src/index.js`
- `index.html` (admin editor injected; hidden unless `?admin` and worker base set)

## Prereqs

- Cloudflare account with Workers enabled.
- GitHub Personal Access Token (fine‑grained) with repository contents read/write for this repo (or a GitHub App installation token).

### 1) Configure wrangler

Edit `cloudflare-worker/wrangler.toml` (pre-filled for your repo and origin):

- Set `account_id` to your Cloudflare account ID.
- GitHub details are set to `urbanjungleirc/staff-site` on branch `main`.
- CORS `ALLOWED_ORIGIN` is set to `https://ujstaff.happyk.au`.
- Optional: `TOOLS_PATH` if your JSON file lives elsewhere.

### 2) Publish the Worker

From repo root (or `cloudflare-worker` folder):

```
cd cloudflare-worker
wrangler login
wrangler secret put GITHUB_TOKEN
# paste your fine‑grained PAT (repo contents: read/write on this repo)

wrangler publish
```

Notes:

- If you prefer, you can deploy via the Cloudflare dashboard by creating a new Worker and pasting `src/index.js`.
- If you use a custom route/domain, add it in `wrangler.toml` under `routes`.
  Recommended: route it under your site as `https://ujstaff.happyk.au/api/*`.

### 3) Protect with Cloudflare Access

In Cloudflare Zero Trust (Access):

- Create an Access Application for the Worker route, e.g., `https://tools-editor.yourdomain.com/*` or `https://<your-subdomain>.workers.dev/*`.
- Add an email or IdP policy to restrict it to staff.

The Worker will receive `Cf-Access-Authenticated-User-Email` for audit; Access itself enforces the authentication.

### 4) Wire the frontend

`index.html` is pre-configured to:

- Read tools from: `https://raw.githubusercontent.com/urbanjungleirc/staff-site/main/tools.json`.
- Call the Worker at base: `/api` (relative to the site origin).

Ensure your Worker is routed to `https://ujstaff.happyk.au/api/*` so the inline editor can reach it.

Usage:

- Open the site with `?admin` to reveal the editor button, e.g., `https://staff.yourdomain.com/?admin`.
- The editor loads/saves via the Worker. Only users allowed by Cloudflare Access can reach it.

Endpoints
---------

- `GET  {WORKER_API_BASE}/tools.json` → returns the current file contents as text/json.
- `POST {WORKER_API_BASE}/tools.json` → body is JSON; commits a pretty‑printed version to the repo.

Commit details
--------------

- Message: `chore(tools): update tools.json via editor (by {email})` when Access provides user email.
- Branch: `GITHUB_BRANCH` (default `main`).
- Author/committer: `COMMITTER_NAME` / `COMMITTER_EMAIL` if set.

Security notes
--------------

- Never embed GitHub tokens in client code. The Worker keeps tokens server‑side.
- Restrict the token scope to only the repo (fine‑grained PAT) or use a GitHub App.
- Lock CORS in the Worker with `ALLOWED_ORIGIN`.

Troubleshooting
---------------

- 401/403 from Worker: verify Cloudflare Access policy and that your browser is authenticated.
- 401/403 from GitHub API: check `GITHUB_TOKEN` scope and repo access.
- Changes not visible on the page: GitHub Pages may take time to rebuild. Use `TOOLS_JSON_URL` (raw) to read the latest file immediately.

Cloudflare account ID
---------------------
- Dashboard: Workers & Pages → Overview shows Account ID in the sidebar.
- Dashboard: Use the top-left account selector → Account Home → Account ID.
- CLI: run `wrangler whoami` to print account and user details.

Worker route setup
------------------
- Dashboard → Workers & Pages → your Worker → Triggers → Add route
- Pattern: `ujstaff.happyk.au/api/*` (pick your zone), Service: `uj-tools-editor`
- Ensure DNS for `ujstaff.happyk.au` is proxied (orange cloud) so the route matches.

Zero Trust Access policy
------------------------
- Cloudflare Zero Trust → Access → Applications → Add application → Self-hosted
- Application domain: `ujstaff.happyk.au`, Path: `/api/*`
- Add policy to include your staff emails or IdP groups.

JSON validation
---------------
- The Worker validates payloads before committing. It expects:
  - Root `object` with `entries: []`
  - Entry type `tool` requires `name` and `path` (strings)
  - Entry type `group` requires `name` and a non-empty `items` array
  - Group item requires `path`; `name` and `buttonText` optional
- Invalid payloads return HTTP 400 with a `details` array explaining issues.
