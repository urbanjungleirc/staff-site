# Clubworx API access for development

Answer to [staff-site#47](https://github.com/urbanjungleirc/staff-site/issues/47),
part of the school-group booking map ([#46](https://github.com/urbanjungleirc/staff-site/issues/46)).
Later tickets on that map (#48–#51) depend on all four sections below.

Status: **sections 1, 2 and 3 settled; section 4 needs Jiri.** No live probe may
run until section 4 is signed off.

---

## 1. Source of the key — SETTLED: reuse, because there is only one

**Clubworx issues exactly one key per gym.** Confirmed by Jiri, 2026-08-17. A
separate key for this integration is **not available**, so the ticket's
reuse-or-issue question is closed by the product: the existing gym key is
reused, and there is no choice in it.

The API reference already pointed this way — it calls `account_key` *"Your gym's
unique API key"* on all **42** endpoints that take it, and never mentions
issuing, revoking or regenerating one — but the admin UI is what settles it.

**Consequence: per-integration attribution by key is impossible.** Every caller
— this tool, the HVT roster Worker, any n8n workflow — presents the same key, so
Clubworx cannot tell them apart, and nothing in an audit trail there will say
which system created a record. Two things follow, and both matter later:

- **Attribution has to live in the data, not the request.** The
  `noreply+<school>@urbanjungleirc.com` marker this map already adopted is what
  identifies a record as this tool's work. That decision was made for dedup and
  search; it is now also the *only* provenance signal, which raises its stakes.
- **Blast radius is shared.** A key rotated for one integration breaks all of
  them at once, and a key leaked from any one of them exposes the whole gym
  database. That is an argument for the gitignore rule in section 2 being
  load-bearing rather than tidy.

**Where the key is.** Jiri holds it — it is already in use by another project.
It is *not* recoverable from this machine or from Cloudflare: the `uj-clubworx`
Worker holds it as a Cloudflare secret, and secrets do not read back out. The
local `uj/hvt-scoring-app/.env` holds only `VITE_CLUBWORX_WORKER_URL` and
`VITE_CLUBWORX_STAFF_SECRET` — the Worker's address and the secret used to call
it, not the Clubworx key. If a fresh copy is ever needed: Clubworx admin UI,
**Settings → API**.

To place it for local probing:

```bash
cd cloudflare-clubworx
cp .dev.vars.example .dev.vars
# then paste the key after CLUBWORX_ACCOUNT_KEY=
```

`.dev.vars` is gitignored, so it stays on the machine and never appears on
GitHub — see section 2.

### A read-only path that needs no key at all

Worth knowing before anyone hurries the key out of the admin UI: the deployed
`uj-clubworx` Worker already proxies a small number of Clubworx **read**
endpoints, and the shared secret needed to call it *is* held locally. Its
routes and auth model are documented in the `hvt` repo alongside its source —
not restated here, since this file is public.

That covers part of the **read** side of probe [#51](https://github.com/urbanjungleirc/staff-site/issues/51)
(event listing) without this project ever holding the raw key. It does **not**
cover the write probes — that Worker exposes no create path — so
[#49](https://github.com/urbanjungleirc/staff-site/issues/49) (plus-addressed
duplicate emails) and [#50](https://github.com/urbanjungleirc/staff-site/issues/50)
(booking a membership-less prospect) still need the key.

One caveat if that shortcut is used: it stops paging after a few hundred records
and flags the result as capped rather than continuing, so it cannot answer #51's
burst-behaviour question. Read its source for the exact limits before relying on
them.

## 2. Location for probing — SETTLED

`cloudflare-clubworx/.dev.vars`, gitignored. Copy `.dev.vars.example` in this
directory and fill it in.

**staff-site is a public repo** (`urbanjungleirc/staff-site`, confirmed
`"visibility": "PUBLIC"`). A key that reaches a commit here is world-readable
and permanent in history. Three things now hold that closed:

- Secret files are ignored **repo-wide** from the root `.gitignore` —
  `.dev.vars`, `.dev.vars.<environment>` (Wrangler's own convention) and `.env`,
  with `.dev.vars.example` excepted so the template stays committable.
  Previously only `cloudflare-worker/` ignored `.dev.vars`, via its own file,
  which protected that one directory and nothing else: a `.dev.vars` in this new
  directory would have been committable. That gap was real and is now closed.
  **This rule is the actual control.**
- `cloudflare-worker/test/secret-hygiene.test.js` checks it: every secret
  filename is ignored in every Worker directory *including ones not yet
  created*, none is tracked anywhere, and no committed file carries a literal
  `account_key=` value. Each was verified able to fail, by planting a fake key
  and a tracked `.dev.vars` and watching the suite go red — one of them first
  passed for the wrong reason and was repaired.

  **It is a check, not a gate.** `pages.yml` is this repo's only workflow and it
  runs no tests, so nothing executes this guard automatically; it fires only
  when someone runs vitest by hand. Wiring it into CI is the open recommendation
  at the end of this file.
- In production the key is a **Wrangler secret** (`npx wrangler secret put
  CLUBWORX_ACCOUNT_KEY`), never `[vars]` in `wrangler.toml`, which is committed.

The key must also never reach the page. The browser talks to this Worker; only
the Worker talks to Clubworx.

One thing that surprises people about this repo: **`.github/workflows/pages.yml`
rsyncs the whole tree into the published site**, excluding only `.git`,
`node_modules` and `_site`. So this directory is itself served — `ACCESS.md` and
`.dev.vars.example` are reachable under `ujstaff.happyk.au/cloudflare-clubworx/`,
and are on GitHub publicly regardless. That is safe *because* the rsync runs
against a CI checkout, which only ever contains tracked files: a gitignored
`.dev.vars` does not exist in CI and cannot be published. It is the same posture
`cloudflare-worker/` has had all along — but it is the reason the gitignore rule
is the load-bearing control here, not a tidiness preference.

## 3. Environment — SETTLED: production only

**There is no Clubworx sandbox.** The 2,365-line API reference at
`uj/automations/ClubworxAPI_docs.md` contains no occurrence of *sandbox*,
*staging*, *test mode*, *demo account*, *rate limit*, *throttle* or *429*. A
public search surfaced no sandbox environment either.

So, plainly: **every probe on this map runs against live production data**, the
same ~60,000-profile database staff use daily. There is no safe rehearsal
environment, and no way to ask for one.

This compounds a constraint already recorded on #46: **Clubworx contacts cannot
be deleted through the API.** Prospects, members and non-attending contacts
expose list / show / create / update only. So each write probe leaves a
**permanent** contact in production, removable only by hand in the Clubworx UI.
Bookings are the exception — `DELETE /api/v2/bookings/:id` exists, so the
booking half of probe #50 is reversible; the contact it needs is not.

**Rate limits are undocumented rather than known to be absent.** Nothing in the
reference describes throttling, retry-after, or a burst ceiling. Probe #51 is
what would discover them empirically. Until it runs, assume limits exist and
are unknown — do not hammer the API.

## 4. Authorisation and test identity — ACTION REQUIRED

Not yet given. Explicitly needed before any write probe runs, because the two
write probes create permanent production records:

- **#49** — create contacts on plus-addressed variants of `noreply@` to see
  whether Clubworx treats them as duplicates.
- **#50** — create a prospect with no membership, then attempt to book it.

**Requested:**

1. Confirmation that write probes against **production** Clubworx are
   authorised, given no sandbox exists and created contacts are permanent.
2. The single fake test identity all probes reuse, so the blast radius is one
   known record rather than a scatter. Proposed, pending approval:
   - name: `Ztest Wayfinder`
   - DOB: `1900-01-01`
   - email: `noreply+wayfindertest@urbanjungleirc.com`
   - Chosen so it sorts to the end of an alphabetical list, is obviously not a
     student, and carries the same `noreply+` marker convention this map
     already adopted for schools. **No real student name, DOB or school may be
     used** — #46's standing constraint, and this repo is public.

Record the answers here and on #47 when given.

---

## Caveats discovered while answering

| Caveat | Consequence |
|---|---|
| No sandbox exists | All probing is against production; unavoidable, not a choice |
| Contacts cannot be deleted via API | Every write probe leaves a permanent record; bookings are reversible, contacts are not |
| Clubworx issues **one key per gym**, confirmed | Attribution by key is impossible; the `noreply+<school>@` marker is the only provenance signal. One key's leak or rotation hits every integration |
| Rate limits undocumented | Unknown, not absent. Probe #51 discovers them; assume they exist meanwhile |
| Existing `uj-clubworx` Worker caps paging at 300 records | Usable for read probes, but cannot answer #51's burst question |
| Cloudflare secrets are write-only | The existing key cannot be recovered; it must come from the admin UI |
| This repo runs no tests in CI | The secret-hygiene guard is advisory until that changes — see below |

## Open recommendation: run the guard in CI

`.github/workflows/pages.yml` is the only workflow here, and it runs no tests —
checkout, version, stage, check, deploy. So the secret-hygiene guard protects
nothing on its own; it only reports when a human runs it.

Given `main` **is** production and merging is deploying, the cheap fix is a
separate workflow on push and pull request that runs just this file. Deliberately
*not* a step inside `pages.yml`: a failing test there would freeze the site on
its previous build, turning a hygiene check into an outage.

Not done here because it changes CI on a public, auto-deploying repo, which is
Jiri's call rather than a detail of #47.
