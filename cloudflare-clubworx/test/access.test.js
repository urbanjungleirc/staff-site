import { describe, it, expect, beforeAll } from 'vitest';
import { createAccessVerifier, certsUrl } from '../src/access.js';

// The Worker's only gate. staff-site#66 is explicit that a present-but-invalid
// JWT is a rejection and never a fallback, so these tests sign real RS256
// tokens with a real key pair and serve a real JWKS from a stubbed fetch.
//
// Asserting against a fake verifier would prove nothing: the failure mode this
// guards against is a verifier that returns ok for a token it never checked,
// and only a genuinely forged signature can catch that.

const TEAM_DOMAIN = 'happyk.cloudflareaccess.com';
const AUD = '65dd83df311d06ffbc7db624cc4e88e3c4d216e716630cfaf60d6d09b7f0e939';
const ISSUER = `https://${TEAM_DOMAIN}`;
const NOW_MS = 1_755_000_000_000; // fixed, so expiry tests do not rot
const NOW_S = Math.floor(NOW_MS / 1000);

const b64url = bytes =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const b64urlJson = obj => b64url(new TextEncoder().encode(JSON.stringify(obj)));

let signingKey;
let otherKey;
let jwks;

/** Sign a JWT with one of the test key pairs. */
async function sign(payload, { kid = 'kid-1', alg = 'RS256', key = signingKey } = {}) {
  const head = b64urlJson({ alg, kid, typ: 'JWT' });
  const body = b64urlJson(payload);
  const signed = `${head}.${body}`;
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key.privateKey,
    new TextEncoder().encode(signed),
  );
  return `${signed}.${b64url(sig)}`;
}

/** The claims Cloudflare Access actually puts in the assertion. */
const validClaims = (over = {}) => ({
  aud: [AUD],
  email: 'staff@urbanjungleirc.com',
  exp: NOW_S + 3600,
  iat: NOW_S - 10,
  nbf: NOW_S - 10,
  iss: ISSUER,
  sub: 'sub-abc',
  ...over,
});

/** A fetch stub that serves the JWKS and counts how often it was asked. */
function jwksFetch(keys = jwks, { status = 200, body = null } = {}) {
  const impl = async url => {
    impl.calls.push(String(url));
    if (status !== 200) return new Response(body ?? 'nope', { status });
    return new Response(JSON.stringify({ keys }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  impl.calls = [];
  return impl;
}

const verifierWith = (fetchImpl, over = {}) =>
  createAccessVerifier({
    teamDomain: TEAM_DOMAIN,
    aud: AUD,
    fetchImpl,
    now: () => NOW_MS,
    ...over,
  });

beforeAll(async () => {
  const params = {
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  };
  signingKey = await crypto.subtle.generateKey(params, true, ['sign', 'verify']);
  otherKey = await crypto.subtle.generateKey(params, true, ['sign', 'verify']);

  const pub = await crypto.subtle.exportKey('jwk', signingKey.publicKey);
  jwks = [{ ...pub, kid: 'kid-1', alg: 'RS256', use: 'sig' }];
});

describe('certsUrl', () => {
  it('points at the team domain, where Access publishes the signing keys', () => {
    expect(certsUrl(TEAM_DOMAIN)).toBe(`https://${TEAM_DOMAIN}/cdn-cgi/access/certs`);
  });

  it('tolerates a team domain written with its scheme', () => {
    expect(certsUrl(`https://${TEAM_DOMAIN}/`)).toBe(`https://${TEAM_DOMAIN}/cdn-cgi/access/certs`);
  });
});

describe('a token that is genuinely valid', () => {
  it('is accepted, and hands back the operator email', async () => {
    const verify = verifierWith(jwksFetch());
    const result = await verify(await sign(validClaims()));

    expect(result.ok).toBe(true);
    expect(result.email).toBe('staff@urbanjungleirc.com');
    expect(result.sub).toBe('sub-abc');
  });

  it('accepts a string aud as well as the array form', async () => {
    const verify = verifierWith(jwksFetch());
    const result = await verify(await sign(validClaims({ aud: AUD })));

    expect(result.ok).toBe(true);
  });

  it('accepts an aud array carrying other applications alongside ours', async () => {
    const verify = verifierWith(jwksFetch());
    const result = await verify(await sign(validClaims({ aud: ['some-other-app', AUD] })));

    expect(result.ok).toBe(true);
  });
});

describe('fail closed', () => {
  it('rejects a missing token — presence is what is being tested, not trusted', async () => {
    const verify = verifierWith(jwksFetch());
    expect((await verify(null)).ok).toBe(false);
    expect((await verify('')).reason).toBe('no-token');
  });

  it('rejects something that is not three dot-separated parts', async () => {
    const verify = verifierWith(jwksFetch());
    expect((await verify('not-a-jwt')).reason).toBe('malformed');
    expect((await verify('a.b')).reason).toBe('malformed');
    expect((await verify('a.b.c.d')).reason).toBe('malformed');
  });

  it('rejects a token whose payload is not decodable JSON', async () => {
    const verify = verifierWith(jwksFetch());
    expect((await verify('eyJhbGciOiJSUzI1NiJ9.@@@@.sig')).reason).toBe('malformed');
  });

  it('rejects a forged signature — the whole point of verifying', async () => {
    const verify = verifierWith(jwksFetch());
    const token = await sign(validClaims());
    // Same header and claims, signature from a different key. A verifier that
    // only decodes would call this valid.
    const forged = `${token.split('.').slice(0, 2).join('.')}.${
      (await sign(validClaims(), { key: otherKey })).split('.')[2]
    }`;

    expect((await verify(forged)).reason).toBe('bad-signature');
  });

  it('rejects a token whose claims were edited after signing', async () => {
    const verify = verifierWith(jwksFetch());
    const [head, , sig] = (await sign(validClaims())).split('.');
    const tampered = `${head}.${b64urlJson(validClaims({ email: 'attacker@example.com' }))}.${sig}`;

    expect((await verify(tampered)).reason).toBe('bad-signature');
  });

  it('rejects alg:none, the classic bypass', async () => {
    const verify = verifierWith(jwksFetch());
    const token = `${b64urlJson({ alg: 'none', kid: 'kid-1', typ: 'JWT' })}.${b64urlJson(
      validClaims(),
    )}.`;

    expect((await verify(token)).reason).toBe('unsupported-alg');
  });

  it('rejects an HS256 token, which would let the public key be used as a secret', async () => {
    const verify = verifierWith(jwksFetch());
    const token = await sign(validClaims(), { alg: 'HS256' });

    expect((await verify(token)).reason).toBe('unsupported-alg');
  });

  it('rejects a kid that is in no published key set', async () => {
    const verify = verifierWith(jwksFetch());
    expect((await verify(await sign(validClaims(), { kid: 'kid-unknown' }))).reason).toBe(
      'unknown-kid',
    );
  });

  it('rejects an expired token', async () => {
    const verify = verifierWith(jwksFetch());
    expect((await verify(await sign(validClaims({ exp: NOW_S - 3600 })))).reason).toBe('expired');
  });

  it('rejects a token that is not valid yet', async () => {
    const verify = verifierWith(jwksFetch());
    expect((await verify(await sign(validClaims({ nbf: NOW_S + 3600 })))).reason).toBe(
      'not-yet-valid',
    );
  });

  it('rejects a token with no expiry at all rather than treating it as eternal', async () => {
    const verify = verifierWith(jwksFetch());
    const claims = validClaims();
    delete claims.exp;

    expect((await verify(await sign(claims))).reason).toBe('expired');
  });

  it('rejects a token issued by a different Access team', async () => {
    const verify = verifierWith(jwksFetch());
    expect(
      (await verify(await sign(validClaims({ iss: 'https://someone-else.cloudflareaccess.com' }))))
        .reason,
    ).toBe('wrong-issuer');
  });

  it('rejects a token minted for a different application on the same team', async () => {
    // Every Access app on happyk.au is signed by the same keys. Without the aud
    // check, a token for the n8n app would open this Worker.
    const verify = verifierWith(jwksFetch());
    expect((await verify(await sign(validClaims({ aud: ['a-different-app'] })))).reason).toBe(
      'wrong-audience',
    );
  });

  it('rejects a validly signed token carrying no email', async () => {
    // Every write is logged against the operator. A token with nobody attached
    // has nothing to log, so it is not good enough to act on.
    const verify = verifierWith(jwksFetch());
    const claims = validClaims();
    delete claims.email;

    expect((await verify(await sign(claims))).reason).toBe('no-email');
  });

  it('rejects everything when the audience is not configured', async () => {
    // An unset ACCESS_AUD must not degrade into "any token from this team".
    const verify = verifierWith(jwksFetch(), { aud: '' });
    expect((await verify(await sign(validClaims()))).reason).toBe('not-configured');
  });

  it('rejects everything when the team domain is not configured', async () => {
    const verify = verifierWith(jwksFetch(), { teamDomain: '' });
    expect((await verify(await sign(validClaims()))).reason).toBe('not-configured');
  });

  it('rejects when the key set cannot be fetched, rather than skipping the check', async () => {
    const verify = verifierWith(jwksFetch(jwks, { status: 503 }));
    expect((await verify(await sign(validClaims()))).reason).toBe('jwks-unavailable');
  });

  it('rejects when the key set fetch throws', async () => {
    const verify = verifierWith(async () => {
      throw new Error('dns');
    });
    expect((await verify(await sign(validClaims()))).reason).toBe('jwks-unavailable');
  });

  it('tolerates a small clock skew rather than rejecting on a second', async () => {
    // Access and this Worker do not share a clock. A token that expired one
    // second ago is a clock difference, not an attack.
    const verify = verifierWith(jwksFetch());
    expect((await verify(await sign(validClaims({ exp: NOW_S - 1 })))).ok).toBe(true);
  });

  it('never reports an email alongside a rejection', async () => {
    const verify = verifierWith(jwksFetch());
    const result = await verify(await sign(validClaims({ exp: NOW_S - 3600 })));

    expect(result.ok).toBe(false);
    expect(result.email).toBeNull();
  });
});

describe('the key set is cached, but not forever', () => {
  it('fetches once for repeated verifications', async () => {
    const fetchImpl = jwksFetch();
    const verify = verifierWith(fetchImpl);

    await verify(await sign(validClaims()));
    await verify(await sign(validClaims()));
    await verify(await sign(validClaims()));

    expect(fetchImpl.calls).toHaveLength(1);
    expect(fetchImpl.calls[0]).toBe(certsUrl(TEAM_DOMAIN));
  });

  it('refetches after the cache expires, so a rotated key is picked up', async () => {
    const fetchImpl = jwksFetch();
    let clock = NOW_MS;
    const verify = createAccessVerifier({
      teamDomain: TEAM_DOMAIN,
      aud: AUD,
      fetchImpl,
      now: () => clock,
      cacheTtlMs: 60_000,
    });

    await verify(await sign(validClaims()));
    clock += 61_000;
    await verify(await sign(validClaims({ exp: Math.floor(clock / 1000) + 3600 })));

    expect(fetchImpl.calls).toHaveLength(2);
  });

  it('refetches once on an unknown kid — a rotation mid-cache, not a forgery', async () => {
    const fetchImpl = jwksFetch();
    let clock = NOW_MS;
    const verify = createAccessVerifier({
      teamDomain: TEAM_DOMAIN,
      aud: AUD,
      fetchImpl,
      now: () => clock,
    });

    await verify(await sign(validClaims())); // warms the cache
    clock += 10 * 60 * 1000; // past the refetch floor, inside the cache TTL
    await verify(await sign(validClaims(), { kid: 'kid-unknown' }));

    expect(fetchImpl.calls).toHaveLength(2);
  });

  it('does not refetch on every unknown kid, or a bad token becomes an outbound flood', async () => {
    // Five garbage kids in quick succession must cost one outbound fetch, not
    // five. Otherwise anyone who can reach the Worker can make it hammer
    // Cloudflare on their behalf, using tokens it is about to reject anyway.
    const fetchImpl = jwksFetch();
    let clock = NOW_MS;
    const verify = createAccessVerifier({
      teamDomain: TEAM_DOMAIN,
      aud: AUD,
      fetchImpl,
      now: () => clock,
    });

    await verify(await sign(validClaims()));
    clock += 10 * 60 * 1000;
    for (let i = 0; i < 5; i += 1) {
      await verify(await sign(validClaims(), { kid: `kid-unknown-${i}` }));
    }

    expect(fetchImpl.calls).toHaveLength(2);
  });

  it('rejects an unknown kid without refetching while the floor holds', async () => {
    const fetchImpl = jwksFetch();
    const verify = verifierWith(fetchImpl);

    await verify(await sign(validClaims()));
    const result = await verify(await sign(validClaims(), { kid: 'kid-unknown' }));

    expect(result.reason).toBe('unknown-kid');
    expect(fetchImpl.calls).toHaveLength(1);
  });
});
