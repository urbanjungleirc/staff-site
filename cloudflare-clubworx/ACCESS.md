# Clubworx API access for development

Answer to [staff-site#47](https://github.com/urbanjungleirc/staff-site/issues/47),
part of the school-group booking map ([#46](https://github.com/urbanjungleirc/staff-site/issues/46)).
Later tickets on that map (#48–#51) depend on all four sections below.

Status: **all four sections settled, 2026-08-17.** #47 is answered and closed.
Write probes on #49 and #50 are authorised against production, under the test
identity in section 4.

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

**Verified working, 2026-08-17.** The key was placed and exercised with a single
read-only `GET /locations`: **HTTP 200**, 5 location rows, ~1.1s. Access is
provisioned, not merely configured.

That request also answered something #51 wants: **Clubworx advertises no
rate-limit headers** — no `Retry-After`, no `X-RateLimit-*`, nothing. So a
client cannot self-throttle from response metadata and cannot learn it is
approaching a ceiling before hitting one. Whatever limits exist must be
discovered by observing failures, which makes conservative pacing in the
bulk-create loop a design requirement rather than a nicety.

That has since been done — [#51](https://github.com/urbanjungleirc/staff-site/issues/51)
measured the ceiling and a pace that clears it, and confirmed the headers stay
absent even mid-throttle. See `probes/51-events-and-burst.md`.

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

> ⚠️ **The rule only protects the branch it is on.** This was hit twice on
> 2026-08-17: the session-start sync hook returns this submodule to `main`,
> which does not carry the rule, while a real `.dev.vars` sits on disk. On that
> checkout git reports `?? cloudflare-clubworx/` — untracked but *not ignored* —
> so a `git add .` or an `-A` commit would stage the key into a public repo.
>
> Merging this `.gitignore` change to `main` is what actually closes the hole.
> Until then, check `git check-ignore cloudflare-clubworx/.dev.vars` returns a
> match before staging anything in this repo.

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

**Bookings are the exception, and this is now measured rather than inferred.**
`DELETE /api/v2/bookings/:id` reversed a live booking on 2026-08-18 — HTTP 200,
confirmed by re-reading the contact's bookings rather than trusting the status
(#60). The call requires **`contact_key` as well as `account_key`, in a
form-encoded body**; omit the contact and it answers `HTTP 401 "Authorization
failed"`, which is indistinguishable from a key that lacks delete permission.
#50 sent it that way first and briefly recorded here that bookings could not be
deleted at all.

**Memberships are not the exception.** `POST /api/v2/memberships` creates one
and no delete appears in the reference, so a School Pass is as permanent as a
contact. It lapses on its `expiration_date` rather than being removed.

See `probes/60-member-school-pass-booking.md`.

**Rate limits are undocumented but no longer unknown.** Nothing in the reference
describes throttling, retry-after, or a burst ceiling. Probe #51 has since
measured them: roughly **50 requests** get through when spent faster than ~3/s,
after which the API returns 429 for about **18 seconds**, with no headers of any
kind to warn or explain. **75 requests/minute, one in flight, ran clean.**

Anything talking to Clubworx from this repo — probes included — paces at or under
that. Full evidence and the reasoning: `probes/51-events-and-burst.md`.

## 4. Authorisation and test identity — SETTLED

**Authorised by Jiri, 2026-08-17.** Write probes may run against **production**
Clubworx — the only environment there is. This covers:

- **#49** — create contacts on plus-addressed variants of `noreply@` to see
  whether Clubworx treats them as duplicates.
- **#50** — create a prospect with no membership, then attempt to book it.

### The agreed test identity

Every write probe on this map reuses **one** identity, so the blast radius is a
single known record rather than a scatter of orphans nobody can find later:

| Field | Value |
|---|---|
| First name | `Ztest` |
| Last name | `Wayfinder` |
| DOB | `1900-01-01` |
| Email | `noreply+wayfindertest@urbanjungleirc.com` |

Chosen so it sorts to the end of an alphabetical list, is unmistakably not a
student, and carries the `noreply+` marker convention this map already adopted.
**No real student name, DOB or school may be used** — #46's standing constraint,
and this repo is public.

### What authorisation does and does not cover

- It covers **creating** the records the probes need, under that identity, in
  production.
- It does **not** make them disposable. Contacts cannot be deleted through the
  API, so every probe contact is permanent and removable only by hand in the
  Clubworx UI. Reuse the one identity; do not improvise new ones per run.
- Bookings **are** reversible, demonstrated in #60: `DELETE /api/v2/bookings/:id`
  removed a live booking and the re-read confirmed it. The call needs
  `contact_key` in a form-encoded body as well as `account_key`; without it the
  answer is `401 "Authorization failed"`, which looks exactly like a missing
  permission. So a write probe may create a booking and clean up after itself —
  but it must still verify by re-reading, not by the status code.
- **A membership is permanent.** `POST /api/v2/memberships` has no counterpart
  delete. Assigning a School Pass to the wrong contact cannot be undone, so it
  carries the same weight as creating a contact: search first, and reuse an
  *active* pass rather than assigning a second.
- Probes are **#49 and #50's** work. #47 provisions access and stops there; it
  ran only a read-only `GET /locations` to prove the key authenticates.

### Amendment, 2026-08-17: three contacts, not one — SPENT

**Authorised by Jiri, 2026-08-17**, when #49 ran. One identity could not answer
the ticket: question 2 asks whether *many* contacts may share an email, and
question 3 asks whether a tag **isolates** a school — an exclusion needs a second
tag to exclude. The set is declared in `probes/lib/identity.mjs` and is the whole
blast radius.

These three now exist in production and are **permanent**:

| | Name | Email | `contact_key` |
|---|---|---|---|
| A | `Ztest Wayfinder` | `noreply+wayfindertest@urbanjungleirc.com` | `e35218ef-4e96-4928-a05f-1c14f56e574f` |
| B | `Ztest Wayfindertwo` | `noreply+wayfindertest@urbanjungleirc.com` | `298dab8a-22b5-41f1-87b9-3936172f8ee1` |
| C | `Ztest Wayfinderthree` | `noreply+wayfindertestb@urbanjungleirc.com` | `b39b1560-e76d-45bc-9f67-d19a1fbcb873` |

**This authorisation is spent.** It covered #49's three contacts, not a standing
allowance. **#50 must reuse them** — they are already the membership-less
prospects that ticket needs. A fourth contact is a new decision.

Findings: `probes/49-plus-addressed-duplicates.md`.

### Amendment, 2026-08-20: two more, for #63 — SPENT

**Authorised by Jiri, 2026-08-20**, when #63 ran. The amendment above is spent
and could not be stretched: #63 asks what `POST /api/v2/members` does when it
**creates** a contact, and every contact from #49 already exists. There is no
way to ask that of a contact that is already there.

Two, not one, for the same structural reason #49 needed three. Question 1 needs
a create carrying only the required fields; questions 3 and 4 need
`membership_plan_id` **on the create call**, which only a contact that does not
yet exist can test. Folding them together would have answered one pair and left
the other resting on the reference.

These two now exist in production and are **permanent**:

| | Name | Email | `contact_key` |
|---|---|---|---|
| D | `Ztest Wayfinderfour` | `noreply+wayfindertest@urbanjungleirc.com` | `5a7f1d25-7964-4f42-bbc2-1ec93e7f7aeb` |
| E | `Ztest Wayfinderfive` | `noreply+wayfindertest@urbanjungleirc.com` | `676df583-e637-42e6-9fee-38631461baad` |

Both were created through `POST /api/v2/members` and both landed **directly in
the `/members` view, holding no membership at all** — so a contact's status view
is set by the endpoint that created it, not derived from holding a pass.

**Two School Passes came with them, and are equally permanent:**

| Contact | Membership | Start | Expires |
|---|---|---|---|
| D | `2629905` | 2026-08-20 | 2026-11-11 |
| E | `2629906` (granted by the create call) | 2026-08-20 | 2026-11-11 |

**This authorisation is spent.** It covered #63's two contacts. A sixth contact
is a new decision. `run-63.mjs` searches before every create and reuses what it
finds, so re-running it costs nothing permanent — verified on 2026-08-20.

Findings: `probes/63-member-creation.md`.

### Before the first write probe

Search first. If `Ztest Wayfinder` already exists from an earlier run, reuse it
rather than creating a second — the identity is only a blast-radius control if
there is exactly one of it.

`run-49.mjs` does this in code (`planContacts`), and a second run of it was
verified to make zero writes. Any new write probe must do the same.

---

## Caveats discovered while answering

| Caveat | Consequence |
|---|---|
| No sandbox exists | All probing is against production; unavoidable, not a choice |
| Contacts cannot be deleted via API | Every write probe leaves a permanent record |
| `DELETE /bookings/:id` needs **`contact_key`**, form-encoded in the body (#50, #60) | Without it: `401 "Authorization failed"` — identical to a permissions failure, and misread as one. Sent correctly it reverses cleanly. Read a 401 here as a malformed request before concluding anything about permissions |
| **Memberships have no delete** (#60) | `POST /memberships` creates a permanent record. A School Pass lapses at `expiration_date`; it cannot be removed. Search first and reuse an active one |
| A membership record has **no `status` field** (#60) | Only `start_date` and `expiration_date`. Code checking `status` reads `undefined` and would treat a live pass as inactive — derive activity from the dates |
| `GET /membership_plans` **truncates at 50** (#60) | UJ has 57 plans and `School Pass` was beyond the default page, so a name lookup reports "no such plan". Same trap as `/events` (#51). Always pass `page_size`, and treat a full page as truncated |
| `POST /members` answers **200**, and works with a **JSON** body (#63) | The reference calls it form-encoded; JSON was tried first because it is the only contact-create shape ever measured here (#49) and it succeeded, so the form shape is still untested. Build on JSON. A client testing for `201` reads a successful create as a failure |
| A contact's **status view is set by the creating endpoint** (#63) | `POST /members` puts a contact straight into `/members` while it holds *no membership at all*. #49's "disjoint views by status" holds, but the status is a label applied at creation, not a consequence of holding a pass |
| `membership_plan_id` **works on `POST /members`** (#63) | The pass is granted by the create call, active immediately, and starts on the **creation day** — the same date the two-call route was sending. A new student is two writes, not three |
| Clubworx issues **one key per gym**, confirmed | Attribution by key is impossible; the `noreply+<school>@` marker is the only provenance signal. One key's leak or rotation hits every integration |
| Rate limits undocumented **and unadvertised** | Confirmed live, and confirmed again *while being throttled* (#51): no `Retry-After` or `X-RateLimit-*` headers come back at any point. A client cannot self-throttle from response metadata or see a ceiling approaching — only hit it |
| The ceiling is **tight**: ~50 fast requests, then ~18s of 429 (#51) | 75 req/min ran clean; 120 did not. Every caller must pace, and the allowance is shared across the whole gym key, so this tool can throttle HVT and vice versa |
| `GET /events` ignores `contact_key` entirely (#51) | The event picker works gym-wide — but this contradicts the published reference, so it may be enforced one day. The paste-the-event-id fallback is mandatory, not a nicety |
| The gitignore rule is **branch-local until merged** | Observed twice on 2026-08-17: the session-start sync hook returns this submodule to `main`, where the rule does not exist, while `.dev.vars` stays on disk. On that checkout the key is untracked-but-not-ignored, so `git add .` would stage it into a public repo. Merging the rule to `main` is what actually closes this |
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
