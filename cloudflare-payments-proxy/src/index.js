// uj-payments-proxy — same-origin bridge from the Access-protected staff site
// to the uj-payments Worker, which lives in a different Cloudflare account.
//
// Cloudflare Access sits in front of this Worker (verified: unauthenticated
// requests to ujstaff.happyk.au/api/* redirect to the Access login), so by the
// time we run, Access has authenticated the user and injected a signed
// Cf-Access-Jwt-Assertion header. We forward it verbatim. uj-payments verifies
// the signature — this proxy trusts nothing and holds no secrets.

const PREFIX = '/api/payments';

// Read-only and staff endpoints only. Without this, the proxy would be an open
// relay into /v1/checkout/sessions, letting anyone create Stripe sessions that
// appear to originate from the staff site.
//
// /v1/voucher-types is public but must be here: the staff page reads it (and
// /v1/voucher-types/:id/items) to populate the create-voucher form, and
// getVoucherTypes elevates to staff mode when the caller is authenticated.
// Note '/v1/voucher-types' does not match the '/v1/vouchers' prefix — the
// characters diverge at 's' vs '-'.
const ALLOWED_PREFIXES = ['/v1/vouchers', '/v1/voucher-types', '/v1/staff/'];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(PREFIX + '/')) {
      return new Response('Not found', { status: 404 });
    }

    const upstreamPath = url.pathname.slice(PREFIX.length);
    if (!ALLOWED_PREFIXES.some((p) => upstreamPath.startsWith(p))) {
      return new Response('Not found', { status: 404 });
    }

    const target = new URL(env.PAYMENTS_ORIGIN);
    target.pathname = upstreamPath;
    target.search = url.search;

    const headers = new Headers();
    const contentType = request.headers.get('Content-Type');
    if (contentType) headers.set('Content-Type', contentType);
    // Present only when Access authenticated this request. Never fabricate it.
    const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
    if (jwt) headers.set('Cf-Access-Jwt-Assertion', jwt);
    // The manager gate on cancel/restore is a second factor, sent by the page.
    const managerSecret = request.headers.get('X-Manager-Secret');
    if (managerSecret) headers.set('X-Manager-Secret', managerSecret);

    const hasBody = !['GET', 'HEAD'].includes(request.method);
    const upstream = new Request(target.toString(), {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      // Required by Node/undici when streaming a request body; Workers ignores it.
      ...(hasBody ? { duplex: 'half' } : {}),
    });

    return fetch(upstream);
  },
};
