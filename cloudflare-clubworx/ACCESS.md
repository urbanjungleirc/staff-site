# Clubworx API access for development

Answer to [staff-site#47](https://github.com/urbanjungleirc/staff-site/issues/47),
part of the school-group booking map ([#46](https://github.com/urbanjungleirc/staff-site/issues/46)).
Later tickets on that map (#48–#51) depend on all four sections below.

Status: **sections 2 and 3 settled; sections 1 and 4 need Jiri.** No live probe
may run until section 4 is signed off.

---

## 1. Source of the key — ACTION REQUIRED

**Where it comes from:** the Clubworx admin UI, **Settings → API**. (Same route
already recorded for the HVT integration in `hvt/docs/CLUBWORX_IMPORT.md`.)

**Why it cannot be recovered from what we already have.** The existing
`uj-clubworx` Worker (in the `hvt` repo) holds the key as a Cloudflare secret,
and Cloudflare does not read secrets back out. The local
`uj/hvt-scoring-app/.env` was checked and holds only
`VITE_CLUBWORX_WORKER_URL` and `VITE_CLUBWORX_STAFF_SECRET` — the address of
that Worker and the shared secret used to call it, not the Clubworx key itself.
The key is genuinely absent from this machine.

**Reuse or issue a separate key?** The ticket asks for this to be decided so
this tool's traffic is attributable. The API reference describes `account_key`
as *"Your gym's unique API key"* — singular, one per gym — on all 30+ endpoints.
That wording suggests per-integration keys are **not offered**, in which case
attribution by key is impossible and the question is moot. This has not been
confirmed against the admin UI, which is the only place that can answer it.

> **To confirm while fetching the key:** does Settings → API let you issue a
> second, separate key, or is there exactly one gym key? If there is only one,
> attribution must come from somewhere else — the `noreply+<school>@` email
> marker this map already adopted is the natural fallback, since it is per-record
> rather than per-request.

### A read-only path that needs no key at all

Worth knowing before anyone hurries the key out of the admin UI: the deployed
`uj-clubworx` Worker already proxies Clubworx reads, authenticated by the
`X-Staff-Secret` we *do* hold locally. It exposes `/v1/events`, `/v1/roster`
and `/v1/lookup`.

That covers part of the **read** side of probe [#51](https://github.com/urbanjungleirc/staff-site/issues/51)
(event listing) without this project ever holding the raw key. It does **not**
cover the write probes — that Worker exposes no create path — so
[#49](https://github.com/urbanjungleirc/staff-site/issues/49) (plus-addressed
duplicate emails) and [#50](https://github.com/urbanjungleirc/staff-site/issues/50)
(booking a membership-less prospect) still need the key.

Two caveats if that shortcut is used: its paging is capped at
`MAX_PAGES = 3 × PAGE_SIZE = 100`, i.e. **300 records**, after which it sets a
`capped` flag rather than continuing — so it cannot answer #51's burst-behaviour
question. And its upstream timeout is 10s.

## 2. Location for probing — SETTLED

`cloudflare-clubworx/.dev.vars`, gitignored. Copy `.dev.vars.example` in this
directory and fill it in.

**staff-site is a public repo** (`urbanjungleirc/staff-site`, confirmed
`"visibility": "PUBLIC"`). A key that reaches a commit here is world-readable
and permanent in history. Three things now hold that closed:

- `.dev.vars` is ignored **repo-wide** from the root `.gitignore`. Previously
  only `cloudflare-worker/` ignored it, via its own file — which protected that
  one directory and nothing else. A `.dev.vars` in this new directory would
  have been committable. That gap was real and is now closed.
- `cloudflare-worker/test/secret-hygiene.test.js` asserts it: `.dev.vars` is
  ignored in every Worker directory *including ones not yet created*, no
  `.dev.vars` is tracked anywhere, and no committed file carries a literal
  `account_key=` value. Both failure modes were verified by planting a fake key
  and a tracked `.dev.vars` and watching the suite go red.
- In production the key is a **Wrangler secret** (`npx wrangler secret put
  CLUBWORX_ACCOUNT_KEY`), never `[vars]` in `wrangler.toml`, which is committed.

The key must also never reach the page. The browser talks to this Worker; only
the Worker talks to Clubworx.

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
| `account_key` is documented as one key per gym | Per-integration attribution may be impossible; confirm in admin UI |
| Rate limits undocumented | Unknown, not absent. Probe #51 discovers them; assume they exist meanwhile |
| Existing `uj-clubworx` Worker caps paging at 300 records | Usable for read probes, but cannot answer #51's burst question |
| Cloudflare secrets are write-only | The existing key cannot be recovered; it must come from the admin UI |
