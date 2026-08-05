// Characterisation tests for the roster / tools.json Worker.
//
// These describe what the Worker does *today* so later slices (calendar
// context, the widened Deputy window) can't change it by accident. Assertions
// stay on the outside of the Worker: status, headers, body, and what upstream
// was asked for. Nothing is exported from src/index.js to make this possible.

import { describe, it, expect, vi, afterEach } from 'vitest';
import worker from '../src/index.js';

const ORIGIN = 'https://ujstaff.happyk.au';

const ROSTER_ENV = {
  ALLOWED_ORIGIN: ORIGIN,
  DEPUTY_URL: 'https://deputy.example.com/api/v1',
  DEPUTY_TOKEN: 'deputy-token',
};

const TOOLS_ENV = {
  ALLOWED_ORIGIN: ORIGIN,
  GITHUB_OWNER: 'urbanjungleirc',
  GITHUB_REPO: 'staff-site',
  GITHUB_BRANCH: 'main',
  TOOLS_PATH: 'tools.json',
  GITHUB_TOKEN: 'gh-token',
};

// Fixed clock so the Deputy query window is assertable.
const NOW_MS = Date.UTC(2026, 7, 5, 4, 0, 0);
const DAY_MS = 86400000;

const call = (path, env, init) =>
  worker.fetch(new Request('https://ujstaff.happyk.au' + path, init), env);

/** A Deputy parent roster record with the metadata the Worker reads. */
const shift = (over = {}) => ({
  Id: 101,
  StartTime: 1770000000,
  EndTime: 1770020000,
  ParentId: null,
  _DPMetaData: {
    EmployeeInfo: { DisplayName: 'Alex Kim' },
    OperationalUnitInfo: { OperationalUnitName: 'Front of House' },
  },
  ...over,
});

/** Stub global fetch with a queue of responses, one per call, in order. */
const stubFetch = (...responses) => {
  let i = 0;
  const upstream = vi.fn(async () => responses[Math.min(i++, responses.length - 1)]());
  vi.stubGlobal('fetch', upstream);
  return upstream;
};

const jsonResponse = (body, status = 200) => () =>
  new Response(JSON.stringify(body), { status });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('CORS', () => {
  it('answers preflight with 204 and the configured origin', async () => {
    const upstream = stubFetch(jsonResponse({}));

    const res = await call('/api/roster', ROSTER_ENV, { method: 'OPTIONS' });

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, OPTIONS');
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe(
      'Content-Type, Authorization, Cf-Access-Jwt-Assertion'
    );
    expect(upstream).not.toHaveBeenCalled();
  });

  it('falls back to a wildcard origin when ALLOWED_ORIGIN is unset', async () => {
    stubFetch(jsonResponse([]), jsonResponse([]));

    const res = await call('/api/roster', { ...ROSTER_ENV, ALLOWED_ORIGIN: undefined });

    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});

describe('/api/roster', () => {
  it('maps Deputy shifts to name/role/start/end and caches for two minutes', async () => {
    stubFetch(jsonResponse([shift()]), jsonResponse([]));

    const res = await call('/api/roster', ROSTER_ENV);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(res.headers.get('Cache-Control')).toBe('max-age=120');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(await res.json()).toEqual([
      { name: 'Alex Kim', role: 'Front of House', start: 1770000000, end: 1770020000 },
    ]);
  });

  it('asks Deputy for a 7-day-past / 14-day-future window by default', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
    const upstream = stubFetch(jsonResponse([]), jsonResponse([]));

    await call('/api/roster', ROSTER_ENV);

    const [url, init] = upstream.mock.calls[0];
    expect(url).toBe('https://deputy.example.com/api/v1/resource/Roster/QUERY');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer deputy-token');

    const { search } = JSON.parse(init.body);
    expect(search.s1).toEqual({
      field: 'StartTime',
      type: 'ge',
      data: Math.floor((NOW_MS - 7 * DAY_MS) / 1000),
    });
    expect(search.s2).toEqual({
      field: 'StartTime',
      type: 'le',
      data: Math.floor((NOW_MS + 14 * DAY_MS) / 1000),
    });
  });

  it('honours DEPUTY_WINDOW_* overrides', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
    const upstream = stubFetch(jsonResponse([]), jsonResponse([]));

    await call('/api/roster', {
      ...ROSTER_ENV,
      DEPUTY_WINDOW_PAST_DAYS: '60',
      DEPUTY_WINDOW_FUTURE_DAYS: '30',
    });

    const { search } = JSON.parse(upstream.mock.calls[0][1].body);
    expect(search.s1.data).toBe(Math.floor((NOW_MS - 60 * DAY_MS) / 1000));
    expect(search.s2.data).toBe(Math.floor((NOW_MS + 30 * DAY_MS) / 1000));
  });

  it('runs a second query for micro-schedule children, filtered by ParentId', async () => {
    const upstream = stubFetch(jsonResponse([]), jsonResponse([]));

    await call('/api/roster', ROSTER_ENV);

    expect(upstream).toHaveBeenCalledTimes(2);
    const { search } = JSON.parse(upstream.mock.calls[1][1].body);
    expect(search.s3).toEqual({ field: 'ParentId', type: 'gt', data: 0 });
  });

  it('replaces a micro-scheduled parent with its child segments, in start order', async () => {
    const child = (id, start, role) =>
      shift({
        Id: id,
        ParentId: 101,
        StartTime: start,
        EndTime: start + 3600,
        _DPMetaData: {
          EmployeeInfo: { DisplayName: 'Alex Kim' },
          OperationalUnitInfo: { OperationalUnitName: role },
        },
      });
    stubFetch(
      jsonResponse([shift()]),
      jsonResponse([child(202, 1770010000, 'Coaching'), child(201, 1770000000, 'Front of House')])
    );

    const res = await call('/api/roster', ROSTER_ENV);

    expect(await res.json()).toEqual([
      { name: 'Alex Kim', role: 'Front of House', start: 1770000000, end: 1770003600, shiftId: 101 },
      { name: 'Alex Kim', role: 'Coaching', start: 1770010000, end: 1770013600, shiftId: 101 },
    ]);
  });

  it('accepts an object-keyed Deputy payload as well as an array', async () => {
    stubFetch(jsonResponse({ '101': shift() }), jsonResponse([]));

    const res = await call('/api/roster', ROSTER_ENV);

    expect(await res.json()).toHaveLength(1);
  });

  it('drops shifts with no employee name or no role', async () => {
    stubFetch(
      jsonResponse([
        shift({ Id: 1, _DPMetaData: { OperationalUnitInfo: { OperationalUnitName: 'FOH' } } }),
        shift({ Id: 2, _DPMetaData: { EmployeeInfo: { DisplayName: 'Sam' } } }),
        shift({ Id: 3 }),
      ]),
      jsonResponse([])
    );

    const res = await call('/api/roster', ROSTER_ENV);

    expect(await res.json()).toEqual([
      { name: 'Alex Kim', role: 'Front of House', start: 1770000000, end: 1770020000 },
    ]);
  });

  it('reports a null end time when Deputy omits EndTime', async () => {
    stubFetch(jsonResponse([shift({ EndTime: undefined })]), jsonResponse([]));

    const res = await call('/api/roster', ROSTER_ENV);

    expect((await res.json())[0].end).toBeNull();
  });

  it('still returns parent shifts when the child query fails', async () => {
    stubFetch(jsonResponse([shift()]), () => new Response('nope', { status: 500 }));

    const res = await call('/api/roster', ROSTER_ENV);

    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(1);
  });

  it('502s with the upstream status and body when Deputy rejects the parent query', async () => {
    stubFetch(() => new Response('rate limited', { status: 429 }), jsonResponse([]));

    const res = await call('/api/roster', ROSTER_ENV);

    expect(res.status).toBe(502);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(await res.json()).toEqual({ error: 'Deputy error 429: rate limited' });
  });

  it('500s when the Deputy credentials are not configured', async () => {
    const upstream = stubFetch(jsonResponse([]));

    const res = await call('/api/roster', { ...ROSTER_ENV, DEPUTY_TOKEN: undefined });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'DEPUTY_TOKEN or DEPUTY_URL not configured' });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('405s a non-GET request and advertises the allowed methods', async () => {
    const upstream = stubFetch(jsonResponse([]));

    const res = await call('/api/roster', ROSTER_ENV, { method: 'POST', body: '{}' });

    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('GET, OPTIONS');
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('/api/tools.json (read)', () => {
  const encoded = (text) => btoa(text);

  it('returns the decoded file, uncached, with the configured origin', async () => {
    const file = '{\n  "entries": []\n}\n';
    const upstream = stubFetch(jsonResponse({ content: encoded(file), sha: 'abc' }));

    const res = await call('/api/tools.json', TOOLS_ENV);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(await res.text()).toBe(file);

    const [url, init] = upstream.mock.calls[0];
    expect(url).toBe(
      'https://api.github.com/repos/urbanjungleirc/staff-site/contents/tools.json?ref=main'
    );
    expect(init.headers.Authorization).toBe('Bearer gh-token');
    expect(init.headers.Accept).toBe('application/vnd.github+json');
  });

  it('tolerates the line-wrapped base64 the Contents API returns', async () => {
    const file = '{"entries":[]}';
    stubFetch(jsonResponse({ content: encoded(file).replace(/(.{4})/g, '$1\n') }));

    const res = await call('/api/tools.json', TOOLS_ENV);

    expect(await res.text()).toBe(file);
  });

  it('falls back to an empty object when GitHub returns no content', async () => {
    stubFetch(jsonResponse({ sha: 'abc' }));

    const res = await call('/api/tools.json', TOOLS_ENV);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{}\n');
  });

  it('500s with the GitHub status when the read fails', async () => {
    stubFetch(() => new Response('Bad credentials', { status: 401 }));

    const res = await call('/api/tools.json', TOOLS_ENV);

    expect(res.status).toBe(500);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect((await res.json()).error).toContain('GitHub GET failed 401');
  });

  it('500s before calling GitHub when the repo vars are missing', async () => {
    const upstream = stubFetch(jsonResponse({}));

    const res = await call('/api/tools.json', { ...TOOLS_ENV, TOOLS_PATH: undefined });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Worker not configured' });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('500s before calling GitHub when the token secret is missing', async () => {
    const upstream = stubFetch(jsonResponse({}));

    const res = await call('/api/tools.json', { ...TOOLS_ENV, GITHUB_TOKEN: undefined });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Missing GITHUB_TOKEN secret' });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('405s an unsupported method and advertises GET, POST, OPTIONS', async () => {
    stubFetch(jsonResponse({}));

    const res = await call('/api/tools.json', TOOLS_ENV, { method: 'DELETE' });

    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('GET, POST, OPTIONS');
  });
});

describe('unknown routes', () => {
  it('404s with a JSON body and CORS headers', async () => {
    const upstream = stubFetch(jsonResponse({}));

    const res = await call('/api/nope', ROSTER_ENV);

    expect(res.status).toBe(404);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(upstream).not.toHaveBeenCalled();
  });
});
