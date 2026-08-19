import { describe, it, expect } from 'vitest';
import { errorMessageOf } from '../src/errors.js';

// Moved from probes/lib/report.test.js when staff-site#66 promoted errorMessageOf
// into the Worker's own module. The Worker and the probes read a Clubworx refusal
// the same way because they read it with the same function.

describe('errorMessageOf', () => {
  it('reads a plain string error — the shape Clubworx actually answers with', () => {
    expect(errorMessageOf({ error: 'Contact has no active membership' })).toBe(
      'Contact has no active membership',
    );
  });

  it('joins a list of errors', () => {
    expect(errorMessageOf({ errors: ['too late', 'no spaces'] })).toBe('too late; no spaces');
  });

  it('flattens field → messages, the Rails shape', () => {
    expect(errorMessageOf({ errors: { base: ['not permitted'], event: 'is full' } })).toBe(
      'base: not permitted; event: is full',
    );
  });

  it('truncates rather than recording an unbounded body', () => {
    const v = errorMessageOf({ error: 'x'.repeat(500) }, { limit: 20 });
    expect(v).toHaveLength(21); // 20 + the ellipsis
    expect(v.endsWith('…')).toBe(true);
  });

  it('returns null when there is no error to read', () => {
    // It must never fall back to serialising the whole body — that is how a row
    // of production data would end up in a log line.
    expect(errorMessageOf({ booking_id: 'bk-1', contact_key: 'ck-real' })).toBeNull();
    expect(errorMessageOf(null)).toBeNull();
    expect(errorMessageOf('<html>')).toBeNull();
    expect(errorMessageOf({ error: '   ' })).toBeNull();
  });
});
