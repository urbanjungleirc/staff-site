# Clubworx probes

Small scripts that answer a specific question about the live Clubworx API, and
the write-ups of what they found. They exist because the API reference is
incomplete and occasionally wrong, and because **Clubworx has no sandbox** — the
only way to learn how it behaves is to ask it, carefully, in production.

| File | What it answers |
|---|---|
| `51-events-and-burst.md` | [#51](https://github.com/urbanjungleirc/staff-site/issues/51) — event listing without a `contact_key`, and rate limits |
| `run-51.mjs` | The probe that produced it |

Access, authorisation and the key's whereabouts: `../ACCESS.md`.

## Running

Needs `../.dev.vars` with `CLUBWORX_ACCOUNT_KEY` — see ACCESS.md section 1.

```bash
cd cloudflare-clubworx
npm install

node probes/run-51.mjs --dry-run     # what it would call, without calling
node probes/run-51.mjs               # event listing, pagination, burst  (~100 reads)
node probes/run-51.mjs --calibrate   # find the ceiling, then verify a pace (~5 min)
node probes/run-51.mjs --walls=3     # measure the ceiling repeatedly
node probes/run-51.mjs --pace-per-min=96   # is this rate sustainable?

npm test                             # the pure logic, no network
```

Runs write a JSON summary to `probes/out/`, which is gitignored.

## The rules these scripts follow

Every one of them is a consequence of *production, public repo, no sandbox*.

- **Read-only unless the ticket says otherwise.** `lib/http.mjs` is the only way
  out to Clubworx and it can only issue GET. #51 needed nothing else. The write
  probes (#49, #50) are separately authorised in ACCESS.md section 4 and must
  reuse the one agreed test identity, because Clubworx **cannot delete contacts
  through the API** — every contact a probe creates is permanent.
- **Never record a row of production data.** Responses are reduced to counts,
  ids, field names and timings by `lib/report.mjs` before anything is printed or
  written. Clubworx holds ~60,000 real people and this repo is public and
  rsynced to a live site by `pages.yml`. `probes/out/` is gitignored as a second
  line, but the first line is that there is nothing sensitive in it to begin
  with.
- **No real names in the repo, including as test inputs.** The burst probe
  queries two-letter fragments rather than a surname list. `last_name` is a
  partial match, so they cost exactly what real surnames would.
- **The key never reaches the output.** `redact()` covers the percent-encoded
  form too, and error paths run through it as well — node interpolates the URL
  into its own connection errors.
- **Pace it.** The API allows roughly 50 requests spent quickly, sends no
  rate-limit headers at all, and 429s for ~18 seconds. Anything new should stay
  at or under **75 requests/minute** — see `51-events-and-burst.md`.

## Layout

```
lib/request.mjs   URL building and redaction        (unit tested)
lib/report.mjs    response → publishable summary    (unit tested)
lib/http.mjs      the only path to Clubworx: GET    (unit tested)
run-51.mjs        the #51 probe itself
```

The libraries are tested and the runner is not. That split is deliberate: the
runner's job is to talk to a live API, which a unit test cannot do, so
everything with a decision in it — what to ask for, what may be written down,
what a burst means — was pushed into a library that can be tested without the
network.
