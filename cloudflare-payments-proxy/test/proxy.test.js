import { describe, it, expect, vi, afterEach } from 'vitest';
import worker from '../src/index.js';

const env = { PAYMENTS_ORIGIN: 'https://uj-payments.example.workers.dev' };
const call = (path, init) => worker.fetch(new Request('https://ujstaff.happyk.au' + path, init), env);

afterEach(() => vi.unstubAllGlobals());

describe('uj-payments-proxy', () => {
  it('forwards an allowlisted staff path, stripping the prefix', async () => {
    const upstream = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', upstream);

    const res = await call('/api/payments/v1/vouchers/search?q=UJ-1', {
      headers: { 'Cf-Access-Jwt-Assertion': 'the-token' },
    });

    expect(res.status).toBe(200);
    const forwarded = upstream.mock.calls[0][0];
    expect(forwarded.url).toBe('https://uj-payments.example.workers.dev/v1/vouchers/search?q=UJ-1');
    expect(forwarded.headers.get('Cf-Access-Jwt-Assertion')).toBe('the-token');
  });

  it('forwards /v1/staff/ paths', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    expect((await call('/api/payments/v1/staff/voucher-types')).status).toBe(200);
  });

  it('forwards /v1/vouchers/analytics to the payments worker', async () => {
    // Assert the proxy relays this path rather than rejecting it as off-allowlist.
    // If ALLOWED_PREFIXES is ever narrowed, the stats page dies — this test says why.
    const upstream = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', upstream);

    const res = await call('/api/payments/v1/vouchers/analytics?from=2026-05&to=2026-06', {
      headers: { 'Cf-Access-Jwt-Assertion': 'the-token' },
    });

    expect(res.status).toBe(200);
    const forwarded = upstream.mock.calls[0][0];
    expect(forwarded.url).toBe('https://uj-payments.example.workers.dev/v1/vouchers/analytics?from=2026-05&to=2026-06');
    expect(forwarded.headers.get('Cf-Access-Jwt-Assertion')).toBe('the-token');
  });

  it('forwards the public voucher-types reads the create form depends on', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    expect((await call('/api/payments/v1/voucher-types')).status).toBe(200);
    expect((await call('/api/payments/v1/voucher-types/gift/items')).status).toBe(200);
  });

  it('forwards the manager second factor on cancel/restore', async () => {
    const upstream = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', upstream);

    await call('/api/payments/v1/vouchers/UJ-1/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Manager-Secret': 'mgr' },
      body: JSON.stringify({ reason: 'test' }),
    });

    expect(upstream.mock.calls[0][0].headers.get('X-Manager-Secret')).toBe('mgr');
  });

  it('404s a non-allowlisted upstream path (no open relay to checkout)', async () => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);

    const res = await call('/api/payments/v1/checkout/sessions', { method: 'POST', body: '{}' });

    expect(res.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('404s anything outside /api/payments/', async () => {
    vi.stubGlobal('fetch', vi.fn());
    expect((await call('/api/roster')).status).toBe(404);
  });

  it('does not invent a JWT header when Access did not set one', async () => {
    const upstream = vi.fn(async () => new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', upstream);

    await call('/api/payments/v1/vouchers/stats');

    expect(upstream.mock.calls[0][0].headers.get('Cf-Access-Jwt-Assertion')).toBeNull();
  });

  it('passes the method and body through', async () => {
    const upstream = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', upstream);

    await call('/api/payments/v1/vouchers/UJ-1/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 10 }),
    });

    const forwarded = upstream.mock.calls[0][0];
    expect(forwarded.method).toBe('POST');
    expect(await forwarded.json()).toEqual({ amount: 10 });
  });
});
