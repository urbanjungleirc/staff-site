# `uj-clubworx-api` — the staff site's Clubworx Worker

staff-site[#66](https://github.com/urbanjungleirc/staff-site/issues/66), part of
the school group booking map ([#46](https://github.com/urbanjungleirc/staff-site/issues/46)).
Design: `docs/superpowers/specs/2026-08-19-school-group-booking-design.md` §6.

This ticket ships the **skeleton**: the Worker, the Access gate, the pacer and
the request layer. The routes that do the work — `events`, `plan`, `schools`,
`contacts`, `student`, `unbook` — arrive with #67, #68 and #70. Until then the
only route is `GET /api/clubworx/health`.

`ACCESS.md` in this directory is the answer to #47: where the key comes from,
where it lives, and what is still owed. Read it first.

## Layout

```text
src/index.js     the Worker: routing, the Access gate, the log line
src/access.js    Cloudflare Access JWT verification against the team JWKS
src/clubworx.js  the only path to Clubworx: paced, redacted, measured shapes
src/pace.js      75 req/min, one in flight — the constant #51 measured
src/request.js   buildUrl + redact                (promoted from probes/lib)
src/errors.js    errorMessageOf                   (promoted from probes/lib)
test/            vitest, run by hand — this repo runs no tests in CI
probes/          the read-only probes, and what they found
```

`src/request.js` and `src/errors.js` were **moved** out of `probes/lib/`, not
copied. The probes import them from here now. They were written against measured
Clubworx behaviour and carry their own test files; a second copy would re-derive
their bugs, and the two would drift on the first fix that only landed in one.

## Auth

**Cloudflare Access.** Access fronts `ujstaff.happyk.au` and injects a signed
`Cf-Access-Jwt-Assertion` header. The Worker **verifies the signature** against
the `happyk.cloudflareaccess.com` JWKS and **fails closed** — it does not trust
the header's presence, and a present-but-invalid token is a rejection rather
than a fallback.

Everything below is a 401, and the client is told only `unauthorized` — the
reason goes to the log, because told apart these reasons describe the gate to
whoever is rattling it:

| Reason | What it was |
|---|---|
| `no-token` | no assertion at all |
| `malformed` | not three decodable segments |
| `unsupported-alg` | anything but `RS256` — `none` and `HS256` are the classic bypasses |
| `unknown-kid` | signed by a key this team does not publish |
| `bad-signature` | forged, or edited after signing |
| `expired` / `not-yet-valid` | outside the token's window, ±30 s of skew |
| `wrong-issuer` | minted by a different Access team |
| `wrong-audience` | minted for a different app **on this team** — every app on `happyk.au` is signed by the same keys |
| `no-email` | valid, but with nobody to attribute a write to |
| `jwks-unavailable` | the key set could not be fetched — a rejection, never a skip |
| `not-configured` | `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` unset |

`workers_dev = false` in `wrangler.toml` is part of this: a `*.workers.dev`
address is not fronted by Access, so leaving it on would publish an
unauthenticated door beside the guarded one.

## What this Worker stores

**Nothing.** No student name or date of birth reaches any Cloudflare store, KV,
D1, or log (§6, D10). There is no run store and no persistence of any kind.

The log line is one JSON object per request carrying the worker name, the
**route path**, the method, the status, the operator email and the elapsed ms —
and on a rejection, the reason.

- **Never the query string.** `GET /contacts?last_name=&dob=` is a route this
  design calls for, so logging a path with its query would put a student's
  surname and date of birth into Cloudflare's log store.
- **Never a body.** One debugging `console.log(body)` is all it would take.

`test/worker.test.js` asserts both directly, because a rule of this shape fails
silently.

## Pacing

**75 requests per minute, one in flight.** #51 measured ~50 fast requests
followed by ~18 s of `429`, and Clubworx advertises **no rate-limit headers at
all** — not even while throttling — so the pace is a design constant rather than
an adaptive one. Concurrency is the wrong lever: the ceiling is on requests, so
running two at once only reaches it sooner.

The allowance is **gym-wide** — the roster Worker and n8n spend from the same
key (#47) — so being under the ceiling alone is not the same as being under it.

## Deploying

`main` is production on this repo, but a Pages publish does **not** touch this
Worker. It deploys on its own:

```bash
cd cloudflare-clubworx
npm install
npx wrangler secret put CLUBWORX_ACCOUNT_KEY   # once, per environment
npx wrangler deploy
```

Then check the gate from a browser already signed in to the staff hub:

```text
https://ujstaff.happyk.au/api/clubworx/health
```

A healthy answer names the operator Access authenticated, which is what proves
the gate ran rather than proving the Worker is awake:

```json
{
  "ok": true,
  "worker": "uj-clubworx-api",
  "email": "you@urbanjungleirc.com",
  "clubworxKey": "configured",
  "time": "2026-08-19T14:00:00.000Z"
}
```

`"clubworxKey": "missing"` means the secret was never put. The health route
makes no Clubworx call, so it answers `200` either way — it reports the fact
rather than hiding it.

## Tests

```bash
cd cloudflare-clubworx
npm test
```

Run `cloudflare-worker/test/secret-hygiene.test.js` too — it asserts the
repo-wide secret rule for Worker directories *including ones that did not exist
when it was written*, which is this one.

Nothing runs either automatically: `pages.yml` is this repo's only workflow and
it runs no tests. Wiring vitest into CI is `ACCESS.md`'s open recommendation and
is still open.
