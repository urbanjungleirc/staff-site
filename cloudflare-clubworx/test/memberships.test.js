import { describe, it, expect } from 'vitest';
import { summariseMemberships, assessPass } from '../src/memberships.js';

// The real shape, from #60's live read. Note what is NOT here: a `status` field.
const SCHOOL_PASS = 64189;
const heldPass = (start, expires) => ({
  id: 2627746,
  membership_plan_id: SCHOOL_PASS,
  name: 'School Pass',
  start_date: start,
  expiration_date: expires,
  class_access: 'Unlimited classes',
  classes_booked: 0,
  classes_remaining: null,
});

describe('summariseMemberships', () => {
  it('derives active from the two dates, because there is no status field', () => {
    const rows = [heldPass('2026-08-18', '2026-11-09')];
    expect(summariseMemberships(rows, SCHOOL_PASS, { on: '2026-09-01' })).toMatchObject({
      holdsPlan: true,
      holdsActivePlan: true,
    });
  });

  it('is inclusive at both ends — a pass is usable on its first and last day', () => {
    const rows = [heldPass('2026-08-18', '2026-11-09')];
    expect(summariseMemberships(rows, SCHOOL_PASS, { on: '2026-08-18' }).holdsActivePlan).toBe(true);
    expect(summariseMemberships(rows, SCHOOL_PASS, { on: '2026-11-09' }).holdsActivePlan).toBe(true);
    expect(summariseMemberships(rows, SCHOOL_PASS, { on: '2026-11-10' }).holdsActivePlan).toBe(false);
    expect(summariseMemberships(rows, SCHOOL_PASS, { on: '2026-08-17' }).holdsActivePlan).toBe(false);
  });

  it('counts an expired pass as held — an expired row still comes back', () => {
    const rows = [heldPass('2026-01-01', '2026-03-25')];
    expect(summariseMemberships(rows, SCHOOL_PASS, { on: '2026-08-20' })).toMatchObject({
      holdsPlan: true,
      holdsActivePlan: false,
    });
  });

  it('ignores a status field if one ever appears, rather than trusting it', () => {
    const v = summariseMemberships(
      [{ membership_plan_id: SCHOOL_PASS, status: 'active' }],
      SCHOOL_PASS,
      { on: '2026-08-20' },
    );
    // No dates at all reads as unbounded, which is the only safe reading of a
    // row with neither end — but it is derived, not read off `status`.
    expect(v.planStates[0]).not.toHaveProperty('status');
  });

  it('compares the plan id as a string, since Clubworx has sent both', () => {
    expect(summariseMemberships([{ membership_plan_id: '64189' }], 64189).holdsPlan).toBe(true);
  });

  it('refuses a body that is not a list rather than reading it as no memberships', () => {
    expect(summariseMemberships(null, SCHOOL_PASS).notAnArray).toBe(true);
    expect(summariseMemberships({ error: 'nope' }, SCHOOL_PASS).notAnArray).toBe(true);
  });

  it('reports field names without their values — how the missing status was found', () => {
    const v = summariseMemberships(
      [{ membership_plan_id: SCHOOL_PASS, member_name: 'A Real Person' }],
      SCHOOL_PASS,
    );
    expect(v.fields).toContain('member_name');
    expect(JSON.stringify(v)).not.toContain('A Real Person');
  });

  it('does not confuse a different plan for the one being looked for', () => {
    const v = summariseMemberships([{ membership_plan_id: 1 }], SCHOOL_PASS);
    expect(v.holdsPlan).toBe(false);
    expect(v.count).toBe(1);
  });
});

describe('assessPass', () => {
  const on = '2026-08-20';

  it('says grant when the student holds no pass on this plan', () => {
    expect(assessPass({ states: [], lastSession: '2026-10-01', on })).toMatchObject({
      state: 'none',
      grant: true,
    });
  });

  it('says skip when the held pass reaches the last selected session', () => {
    const states = summariseMemberships([heldPass('2026-08-01', '2027-01-28')], SCHOOL_PASS, { on })
      .planStates;
    expect(assessPass({ states, lastSession: '2026-10-01', on })).toMatchObject({
      state: 'covering',
      grant: false,
    });
  });

  it('covers a session that lands exactly on the expiration date', () => {
    const states = summariseMemberships([heldPass('2026-08-01', '2026-10-01')], SCHOOL_PASS, { on })
      .planStates;
    expect(assessPass({ states, lastSession: '2026-10-01', on }).state).toBe('covering');
  });

  it('says grant when the held pass has already expired', () => {
    const states = summariseMemberships([heldPass('2026-01-01', '2026-03-25')], SCHOOL_PASS, { on })
      .planStates;
    expect(assessPass({ states, lastSession: '2026-10-01', on })).toMatchObject({
      state: 'expired',
      grant: true,
    });
  });

  // The row ADR 0005 created. Under a 12-week pass this was rare; at 26 weeks a
  // returning student regularly holds one that is live and expires mid-term.
  it('refuses rather than granting a second pass to a live holder', () => {
    const states = summariseMemberships([heldPass('2026-08-01', '2026-09-15')], SCHOOL_PASS, { on })
      .planStates;
    const verdict = assessPass({ states, lastSession: '2026-10-01', on });
    expect(verdict).toMatchObject({ state: 'needs-confirmation', grant: false });
    // The operator has to be able to see the two dates that disagree.
    expect(verdict.expirationDate).toBe('2026-09-15');
    expect(verdict.lastSession).toBe('2026-10-01');
  });

  it('names the shortfall in a sentence an operator can act on', () => {
    const states = summariseMemberships([heldPass('2026-08-01', '2026-09-15')], SCHOOL_PASS, { on })
      .planStates;
    const { detail } = assessPass({ states, lastSession: '2026-10-01', on });
    expect(detail).toContain('2026-09-15');
    expect(detail).toContain('2026-10-01');
  });

  it('refuses a pass that has not started yet rather than granting alongside it', () => {
    const states = summariseMemberships([heldPass('2026-09-01', '2027-03-01')], SCHOOL_PASS, { on })
      .planStates;
    expect(assessPass({ states, lastSession: '2026-10-01', on })).toMatchObject({
      state: 'needs-confirmation',
      grant: false,
    });
  });

  it('treats a pass with no expiration as covering, not as expired', () => {
    const states = summariseMemberships([heldPass('2026-08-01', null)], SCHOOL_PASS, { on })
      .planStates;
    expect(assessPass({ states, lastSession: '2027-10-01', on }).state).toBe('covering');
  });

  it('picks the best of several held passes rather than the first', () => {
    const states = summariseMemberships(
      [heldPass('2026-01-01', '2026-03-25'), heldPass('2026-08-01', '2027-01-28')],
      SCHOOL_PASS,
      { on },
    ).planStates;
    expect(assessPass({ states, lastSession: '2026-10-01', on }).state).toBe('covering');
  });

  it('refuses when the last session is not a real day — it decides a permanent write', () => {
    expect(assessPass({ states: [], lastSession: 'soon', on }).state).toBe('unknown');
    expect(assessPass({ states: [], lastSession: '2026-10-01', on: 'today' }).state).toBe('unknown');
  });
});
