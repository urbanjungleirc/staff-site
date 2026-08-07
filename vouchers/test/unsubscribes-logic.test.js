import { describe, expect, test } from 'vitest';
import {
  partitionSuppressions,
  isRemovable,
  sourceLabel,
  matchMembers,
  isFreeTextOffer,
} from '../unsubscribes-logic.js';

// The page's subject is the UNION of two suppression sources, only one of which
// this system can edit. These tests pin the rules that decide what staff are
// shown and what they are allowed to act on — the places where a wrong answer
// is silent rather than loud.

describe('partitionSuppressions', () => {
  test('splits rows by whether they are still in the member list', () => {
    const { current, former } = partitionSuppressions([
      { email: 'a@example.com', in_current_list: true },
      { email: 'b@example.com', in_current_list: false },
    ]);

    expect(current.map((r) => r.email)).toEqual(['a@example.com']);
    expect(former.map((r) => r.email)).toEqual(['b@example.com']);
  });

  test('treats a missing flag as a former member rather than a current one', () => {
    // Erring the other way would hide a stale opt-out in the main list, where
    // it reads as an active member who is being suppressed.
    const { current, former } = partitionSuppressions([{ email: 'a@example.com' }]);

    expect(current).toEqual([]);
    expect(former).toHaveLength(1);
  });
});

describe('isRemovable', () => {
  test('an opt-out recorded via the unsubscribe link can be removed here', () => {
    expect(isRemovable({ sources: ['email_link'] })).toBe(true);
  });

  test('an opt-out recorded by staff can be removed here', () => {
    expect(isRemovable({ sources: ['staff'] })).toBe(true);
  });

  test('a Clubworx-only row cannot be removed here', () => {
    // This system never writes to Clubworx. Offering a Resubscribe button would
    // promise an action that cannot happen.
    expect(isRemovable({ sources: ['clubworx'] })).toBe(false);
  });

  test('a row suppressed by both sources is still removable', () => {
    // The opt-out half is ours to delete even though the row will survive.
    expect(isRemovable({ sources: ['staff', 'clubworx'] })).toBe(true);
  });

  test('a row with no sources is not removable', () => {
    expect(isRemovable({ sources: [] })).toBe(false);
  });
});

describe('sourceLabel', () => {
  test('names each source in the member’s vocabulary, not the database’s', () => {
    expect(sourceLabel('email_link')).toBe('Via unsubscribe link');
    expect(sourceLabel('staff')).toBe('Added by staff');
    expect(sourceLabel('clubworx')).toBe('Unsubscribed in Clubworx');
  });

  test('falls back to the raw value for an unknown source', () => {
    // A future source must render as something rather than vanishing.
    expect(sourceLabel('imported')).toBe('imported');
  });

  test('says a just-resubscribed address is STILL suppressed by Clubworx', () => {
    // Removing the opt-out on a doubly-suppressed address looks like it worked
    // and changes nothing the member can see. The badge has to say so.
    expect(sourceLabel('clubworx', { justResubscribed: true }))
      .toBe('Still suppressed — unsubscribed in Clubworx');
  });

  test('leaves our own sources unchanged after a resubscribe', () => {
    expect(sourceLabel('staff', { justResubscribed: true })).toBe('Added by staff');
  });
});

describe('matchMembers', () => {
  const members = [
    { email: 'jo@example.com', names: ['Jo Smith'] },
    { email: 'sam@example.com', names: ['Sam Jones'] },
    { email: 'shared@example.com', names: ['Pat Lee', 'Alex Lee'] },
  ];

  test('offers nothing until something is typed', () => {
    expect(matchMembers(members, '', new Set())).toEqual([]);
    expect(matchMembers(members, '   ', new Set())).toEqual([]);
  });

  test('matches on part of the email address', () => {
    const found = matchMembers(members, 'sam@', new Set());

    expect(found.map((m) => m.email)).toEqual(['sam@example.com']);
  });

  test('matches on a name regardless of case', () => {
    const found = matchMembers(members, 'jo smith', new Set());

    expect(found.map((m) => m.email)).toEqual(['jo@example.com']);
  });

  test('matches any of the names sharing one mailbox', () => {
    const found = matchMembers(members, 'alex', new Set());

    expect(found.map((m) => m.email)).toEqual(['shared@example.com']);
  });

  test('flags a member who is already suppressed', () => {
    // The picker disables these, so staff cannot record a second opt-out that
    // silently no-ops against the primary key.
    const found = matchMembers(members, 'jo', new Set(['jo@example.com']));

    expect(found[0].alreadySuppressed).toBe(true);
  });

  test('leaves a member who is not suppressed selectable', () => {
    const found = matchMembers(members, 'sam', new Set(['jo@example.com']));

    expect(found[0].alreadySuppressed).toBe(false);
  });

  test('recognises an already-suppressed member whose address differs only by case', () => {
    // Addresses arrive from two directions and only one is normalised. A missed
    // match re-enables the picker for someone already on the list, and the
    // insert then no-ops against the primary key.
    const mixedCase = [{ email: 'JO@Example.com', names: ['Jo Smith'] }];

    expect(matchMembers(mixedCase, 'jo', new Set(['jo@example.com']))[0].alreadySuppressed).toBe(true);
  });

  test('caps the menu at 25 so it stays scannable', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      email: `member${i}@example.com`,
      names: [`Member ${i}`],
    }));

    expect(matchMembers(many, 'member', new Set())).toHaveLength(25);
  });
});

describe('isFreeTextOffer', () => {
  const members = [{ email: 'jo@example.com', names: ['Jo Smith'] }];

  test('is not offered for text that is not an address', () => {
    expect(isFreeTextOffer(members, 'jo')).toBe(false);
  });

  test('is offered for a plausible address that no member holds', () => {
    // Allowed, but the UI flags it: an address matching nobody suppresses
    // nobody, and inserts happily either way.
    expect(isFreeTextOffer(members, 'someone@example.com')).toBe(true);
  });

  test('is not offered when a member already holds that exact address', () => {
    // The escape hatch must never shadow the picker.
    expect(isFreeTextOffer(members, 'jo@example.com')).toBe(false);
  });

  test('ignores surrounding whitespace and case when matching a member', () => {
    expect(isFreeTextOffer(members, '  JO@example.com  ')).toBe(false);
  });

  test('is not offered for empty input', () => {
    expect(isFreeTextOffer(members, '')).toBe(false);
  });
});
