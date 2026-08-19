/**
 * Cloudflare Access JWT verification — this Worker's only gate.
 *
 * Access sits in front of `ujstaff.happyk.au` and injects a signed
 * `Cf-Access-Jwt-Assertion` header on every request it lets through. The
 * temptation is to read the header's presence and get on with it. staff-site#66
 * rules that out, for a reason worth restating: **the header is only a proof if
 * its signature is checked.** A request that reaches this Worker by any path
 * Access does not front — a route added later, a `workers.dev` subdomain left
 * on, a service binding — carries whatever header its sender chose to write.
 *
 * So: the signature is verified against the team's published JWKS, and every
 * failure is a rejection. **There is no fallback branch in this file.** A
 * present-but-invalid token is further from acceptable than an absent one, not
 * closer, and unset configuration rejects everything rather than degrading into
 * "any token from this team".
 *
 * The verified email is what the Worker logs against each write (§6). A token
 * that carries no email is therefore not good enough to act on: there would be
 * nothing to attribute the write to, which is the one control standing in for
 * the per-integration attribution Clubworx cannot give (#47).
 */

/** Clock skew tolerated on `exp` and `nbf`, in seconds. */
const SKEW_S = 30;

/** How long a fetched key set is trusted before it is fetched again. */
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * The floor between two key-set fetches provoked by an unknown `kid`.
 *
 * Access rotates keys, so an unknown kid can legitimately mean "the cache is
 * stale" and one refetch is right. Refetching on *every* unknown kid is not:
 * a caller sending garbage kids would turn each rejected request into an
 * outbound request of ours.
 */
const UNKNOWN_KID_REFETCH_FLOOR_MS = 5 * 60 * 1000;

/**
 * Where a team publishes its Access signing keys.
 *
 * @param {string} teamDomain e.g. `happyk.cloudflareaccess.com`
 * @returns {string}
 */
export function certsUrl(teamDomain) {
  const host = String(teamDomain)
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  return `https://${host}/cdn-cgi/access/certs`;
}

const reject = reason => ({ ok: false, reason, email: null, sub: null });

const decodeSegment = segment => {
  const b64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const decodeJson = segment => JSON.parse(new TextDecoder().decode(decodeSegment(segment)));

/**
 * Build a verifier bound to one Access team and one application.
 *
 * @param {object} opts
 * @param {string} opts.teamDomain    `happyk.cloudflareaccess.com`
 * @param {string} opts.aud           The Access application's AUD tag
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {() => number} [opts.now]
 * @param {number} [opts.cacheTtlMs]
 * @returns {(token: string|null) => Promise<{ok: boolean, reason?: string, email: string|null, sub: string|null}>}
 */
export function createAccessVerifier({
  teamDomain,
  aud,
  fetchImpl = fetch,
  now = Date.now,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
}) {
  /** @type {{keys: any[], fetchedAt: number} | null} */
  let cache = null;
  /** kid → imported CryptoKey, so a hot path does not re-import on every call. */
  let imported = new Map();
  let lastFetchAttemptAt = -Infinity;

  const loadKeys = async () => {
    lastFetchAttemptAt = now();
    const res = await fetchImpl(certsUrl(teamDomain));
    if (!res || !res.ok) throw new Error(`jwks ${res ? res.status : 'no response'}`);
    const body = await res.json();
    const keys = Array.isArray(body?.keys) ? body.keys : [];
    if (keys.length === 0) throw new Error('jwks empty');
    cache = { keys, fetchedAt: now() };
    imported = new Map();
    return cache;
  };

  const keyFor = async kid => {
    if (!cache || now() - cache.fetchedAt > cacheTtlMs) await loadKeys();

    let jwk = cache.keys.find(k => k.kid === kid);
    if (!jwk && now() - lastFetchAttemptAt > UNKNOWN_KID_REFETCH_FLOOR_MS) {
      // Access rotated mid-cache, most likely. One refetch, then take the answer.
      await loadKeys();
      jwk = cache.keys.find(k => k.kid === kid);
    }
    if (!jwk) return null;

    if (!imported.has(kid)) {
      imported.set(
        kid,
        await crypto.subtle.importKey(
          'jwk',
          { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
          { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
          false,
          ['verify'],
        ),
      );
    }
    return imported.get(kid);
  };

  return async function verify(token) {
    // Unset configuration is a rejection, not a relaxation. This is the branch
    // that would otherwise quietly turn a misdeploy into an open Worker.
    if (!teamDomain || !aud) return reject('not-configured');
    if (!token) return reject('no-token');

    const parts = String(token).split('.');
    if (parts.length !== 3) return reject('malformed');

    let header;
    let claims;
    try {
      header = decodeJson(parts[0]);
      claims = decodeJson(parts[1]);
    } catch {
      return reject('malformed');
    }
    if (!header || typeof header !== 'object' || !claims || typeof claims !== 'object') {
      return reject('malformed');
    }

    // Only RS256, and only from the header we are about to verify with. `none`
    // is the classic bypass; HS256 is the one where a verifier can be tricked
    // into using the public key as a shared secret.
    if (header.alg !== 'RS256') return reject('unsupported-alg');
    if (!header.kid) return reject('unknown-kid');

    let key;
    try {
      key = await keyFor(header.kid);
    } catch {
      // No key set means no way to check. That is a rejection, never a skip.
      return reject('jwks-unavailable');
    }
    if (!key) return reject('unknown-kid');

    let signatureOk = false;
    try {
      signatureOk = await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        key,
        decodeSegment(parts[2]),
        new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
      );
    } catch {
      signatureOk = false;
    }
    if (!signatureOk) return reject('bad-signature');

    // Claims are only worth reading now that the signature holds.
    const nowS = Math.floor(now() / 1000);

    // A token with no `exp` is treated as expired rather than as eternal.
    if (typeof claims.exp !== 'number' || nowS > claims.exp + SKEW_S) return reject('expired');
    if (typeof claims.nbf === 'number' && nowS + SKEW_S < claims.nbf) return reject('not-yet-valid');

    if (claims.iss !== `https://${certsUrl(teamDomain).split('/')[2]}`) return reject('wrong-issuer');

    // Every Access application on this team is signed by the same keys, so
    // without this a token minted for the n8n app would open this Worker.
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(aud)) return reject('wrong-audience');

    if (!claims.email) return reject('no-email');

    return { ok: true, email: String(claims.email), sub: claims.sub ? String(claims.sub) : null };
  };
}
