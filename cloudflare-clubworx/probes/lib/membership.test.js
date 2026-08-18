import { describe, it, expect } from 'vitest';
import { createMembershipAssigner, assertProbeMembership } from './membership.mjs';

// Memberships have list and create in the reference and **no delete**, so an
// assignment is as permanent as a contact — a lasting mark on a real person's
// record. The assertions here are mostly about what this module refuses to do.

const key = 'unique-not-a-real-key';
const OURS = 'ck-probe-a';
const STRANGER = 'ck-somebody-real';
const PLAN = 64189;

const fakeFetch = (calls, response = {}) => async (url, init) => {
  calls.push({ url, init });
  return {
    status: response.status ?? 200,
    headers: new Headers(response.headers ?? { 'content-type': 'application/json' }),
    text: async () => response.text ?? '{"membership_plan_id":64189}',
  };
};

const assigner = (calls, opts = {}) =>
  createMembershipAssigner({
    accountKey: key,
    allowedContactKeys: [OURS],
    fetchImpl: fakeFetch(calls, opts.response),
    ...opts,
  });

describe('assertProbeMembership', () => {
  it('refuses a contact that did not come from the identity-filtered search', () => {
    expect(() =>
      assertProbeMembership({ contact_key: STRANGER, membership_plan_id: PLAN }, [OURS]),
    ).toThrow(/not a recognised probe contact/);
  });

  it('refuses when no probe contacts were recognised at all', () => {
    expect(() => assertProbeMembership({ contact_key: OURS, membership_plan_id: PLAN }, [])).toThrow(
      /no probe contacts were recognised/,
    );
  });

  it('refuses without a plan id, rather than assigning some default', () => {
    expect(() => assertProbeMembership({ contact_key: OURS }, [OURS])).toThrow(
      /without a membership_plan_id/,
    );
  });

  it('accepts a recognised contact with a plan', () => {
    expect(() =>
      assertProbeMembership({ contact_key: OURS, membership_plan_id: PLAN }, [OURS]),
    ).not.toThrow();
  });
});

describe('createMembershipAssigner', () => {
  it('does not touch the network unless writing is explicitly enabled', async () => {
    const calls = [];
    const { assign } = assigner(calls);

    const res = await assign({ contact_key: OURS, membership_plan_id: PLAN });

    expect(calls).toHaveLength(0);
    expect(res.dryRun).toBe(true);
  });

  it('runs the guard on a dry run too, and issues nothing', async () => {
    const calls = [];
    const { assign } = assigner(calls);

    const res = await assign({ contact_key: STRANGER, membership_plan_id: PLAN });

    expect(res.refused).toMatch(/not a recognised probe contact/);
    expect(calls).toHaveLength(0);
  });

  it('refuses a stranger even when live, without issuing a request', async () => {
    const calls = [];
    const { assign } = assigner(calls, { live: true });

    const res = await assign({ contact_key: STRANGER, membership_plan_id: PLAN });

    expect(res.refused).toBeTruthy();
    expect(calls).toHaveLength(0);
    expect(assign.writes).toBe(0);
  });

  it('sends a form-encoded body, which is what the reference documents', async () => {
    // #50 sent DELETE's parameters the wrong way and read the result as a
    // permissions failure. Guessing a request's shape here is expensive.
    const calls = [];
    const { assign } = assigner(calls, { live: true });

    await assign({ contact_key: OURS, membership_plan_id: PLAN, start_date: '2026-08-18' });

    expect(calls[0].init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const sent = new URLSearchParams(calls[0].init.body);
    expect(sent.get('contact_key')).toBe(OURS);
    expect(sent.get('membership_plan_id')).toBe(String(PLAN));
    expect(sent.get('start_date')).toBe('2026-08-18');
    expect(sent.get('account_key')).toBe(key);
  });

  it('omits start_date rather than sending an empty one', async () => {
    const calls = [];
    const { assign } = assigner(calls, { live: true });

    await assign({ contact_key: OURS, membership_plan_id: PLAN });

    expect(new URLSearchParams(calls[0].init.body).has('start_date')).toBe(false);
  });

  it('keeps the account key out of what it reports, while still sending it', async () => {
    const calls = [];
    const { assign } = assigner(calls, { live: true });

    const res = await assign({ contact_key: OURS, membership_plan_id: PLAN });

    expect(JSON.stringify(res)).not.toContain(key);
    expect(res.sent.account_key).toBeUndefined();
    expect(new URLSearchParams(calls[0].init.body).get('account_key')).toBe(key);
  });

  it('keeps a non-JSON error body as redacted text', async () => {
    const { assign } = assigner([], {
      live: true,
      response: {
        status: 422,
        text: `<html>bad plan for ${key}</html>`,
        headers: { 'content-type': 'text/html' },
      },
    });

    const res = await assign({ contact_key: OURS, membership_plan_id: PLAN });

    expect(res.status).toBe(422);
    expect(res.bodyText).toContain('bad plan');
    expect(res.bodyText).not.toContain(key);
  });

  it('redacts the key out of a connection error', async () => {
    const { assign } = createMembershipAssigner({
      accountKey: key,
      allowedContactKeys: [OURS],
      live: true,
      fetchImpl: async () => {
        throw new Error(`ECONNREFUSED account_key=${key}`);
      },
    });

    const res = await assign({ contact_key: OURS, membership_plan_id: PLAN });

    expect(res.error).not.toContain(key);
    expect(res.error).toContain('<CLUBWORX_ACCOUNT_KEY>');
  });
});
