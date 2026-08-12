import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  SURFACES, EMAIL_CUSTOMISABLE_FIELDS, PUBLIC_PAGE_FIELDS, DEFAULT_ACCENT,
  HERO_ARTWORK_COMPOSITION_RULE,
  surfaceOf, isUntouched, chipFor, unreviewedSurfaces, backdropFallbackCss,
} from '../type-surfaces.js';

// Read once — several tests below check the editor's markup, and re-reading a
// 200KB file per assertion buys nothing.
let cachedIndexHtml;
const indexHtml = () => (cachedIndexHtml ??= readFileSync(
  new URL('../index.html', import.meta.url), 'utf8'));

// The columns blankTypeForm() actually seeds, read out of index.html rather
// than copied. A field added to the editor and to no surface has to fail the
// partition test below, and it only can if this list comes from the source.
function editorDraftFields() {
  const html = indexHtml();
  const body = html.match(/blankTypeForm\(\)\s*\{\s*return\s*\{([\s\S]*?)\n\s*\};/);
  if (!body) throw new Error('could not find blankTypeForm() in index.html');
  return [...body[1].matchAll(/(?:^|[{,])\s*([a-z_][a-z0-9_]*)\s*:/gi)].map(m => m[1]);
}

// A blank draft as blankTypeForm() produces it. Two fields carry pre-filled
// defaults (redemption_instructions, voucher_label) — that is the point of the
// "defaults don't count as customisation" rule below.
const blankDraft = () => ({
  type_id: '', display_name: '', description: '',
  availability: 'both', revenue_class: 'sale', expiry_months: '', max_per_customer: '',
  limit_period: '', promo_id: '', sort_order: 0,
  is_physical: false, is_active: true,
  email_subject: '', email_body: '',
  terms_conditions: '', usage_info: '',
  redemption_instructions: 'Scan at the front desk to redeem',
  accent_color: '#ae222a', voucher_label: 'Your Voucher',
  show_qr: true, show_value: true,
  redemption_warning: '',
  hero_headline: '', hero_subheadline: '', hero_description: '',
  cta_label: '', hero_image_url: '', hero_background_url: '',
  features_heading: '', features_subheading: '', features_md: '',
});

describe('the surface partition', () => {
  it('has exactly three surfaces, in editor order', () => {
    expect(SURFACES.map(s => s.id)).toEqual(['setup', 'email', 'public']);
  });

  // Guards the fixture above: if it drifts from the editor, every other test in
  // this file is asserting against a type that no longer exists.
  it('has a fixture matching the editor blank form field for field', () => {
    expect(Object.keys(blankDraft()).sort()).toEqual(editorDraftFields().sort());
  });

  it('assigns every field the editor puts on a draft to exactly one surface', () => {
    for (const field of editorDraftFields()) {
      const owners = SURFACES.filter(s => s.fields.includes(field));
      expect(owners, `${field} should belong to exactly one surface`).toHaveLength(1);
    }
  });

  it('claims no field the editor does not put on a draft', () => {
    const fields = new Set(editorDraftFields());
    for (const surface of SURFACES) {
      for (const field of surface.fields) {
        expect(fields.has(field), `${field} is on ${surface.id} but not on the draft`).toBe(true);
      }
    }
  });

  // The email renderer in payments-worker consumes exactly these nine columns.
  // That count is what fixes the Email tab's membership, and is why branding
  // sits with the email rather than with the public page.
  it('gives the email surface the nine fields the email renderer consumes', () => {
    expect(surfaceOf('email_subject')).toBe('email');
    expect(surfaceOf('email_body')).toBe('email');
    expect(surfaceOf('terms_conditions')).toBe('email');
    expect(surfaceOf('usage_info')).toBe('email');
    expect(surfaceOf('redemption_instructions')).toBe('email');
    expect(surfaceOf('accent_color')).toBe('email');
    expect(surfaceOf('voucher_label')).toBe('email');
    expect(surfaceOf('show_qr')).toBe('email');
    expect(surfaceOf('show_value')).toBe('email');
    expect(SURFACES.find(s => s.id === 'email').fields).toHaveLength(9);
  });

  it('keeps the staff redemption warning on setup, not on a surface of its own', () => {
    expect(surfaceOf('redemption_warning')).toBe('setup');
  });

  // The display name feeds the email heading but stays on Setup: the modal
  // title renders it reactively, so it is on screen whichever tab is active.
  it('keeps identity fields on setup even when they feed another surface', () => {
    expect(surfaceOf('display_name')).toBe('setup');
    expect(surfaceOf('type_id')).toBe('setup');
  });

  it('returns null for a field it does not know', () => {
    expect(surfaceOf('not_a_column')).toBe(null);
  });
});

describe('untouched surfaces', () => {
  it('reports email and public page as untouched for a blank draft', () => {
    const d = blankDraft();
    expect(isUntouched('email', d)).toBe(true);
    expect(isUntouched('public', d)).toBe(true);
  });

  // Identity fields are required, so setup is always populated. A chip that is
  // permanently lit is noise, not information.
  it('never reports setup as untouched', () => {
    expect(isUntouched('setup', blankDraft())).toBe(false);
    expect(isUntouched('setup', { ...blankDraft(), display_name: 'Gift Voucher' })).toBe(false);
  });

  it('clears the email chip when any one free-text email field is filled', () => {
    for (const field of EMAIL_CUSTOMISABLE_FIELDS) {
      expect(isUntouched('email', { ...blankDraft(), [field]: 'x' }),
        `${field} should count as email customisation`).toBe(false);
    }
  });

  // The pre-filled defaults arrive on every new draft. If they counted, no type
  // would ever read as untouched and the chip would never appear.
  it('does not count the pre-filled email defaults as customisation', () => {
    expect(EMAIL_CUSTOMISABLE_FIELDS).toEqual(
      ['email_subject', 'email_body', 'terms_conditions', 'usage_info']);
    expect(isUntouched('email', blankDraft())).toBe(true);
  });

  it('clears the public page chip when any one of its nine fields is filled', () => {
    expect(PUBLIC_PAGE_FIELDS).toHaveLength(9);
    for (const field of PUBLIC_PAGE_FIELDS) {
      expect(isUntouched('public', { ...blankDraft(), [field]: 'x' }),
        `${field} should count as public page customisation`).toBe(false);
    }
  });

  it('treats whitespace-only and null as still untouched', () => {
    expect(isUntouched('public', { ...blankDraft(), hero_headline: '   ' })).toBe(true);
    expect(isUntouched('email', { ...blankDraft(), email_body: null })).toBe(true);
  });

  it('names the consequence rather than just the state', () => {
    const d = blankDraft();
    expect(chipFor('email', d)).toMatch(/default/i);
    expect(chipFor('public', d)).toMatch(/gift voucher/i);
    expect(chipFor('setup', d)).toBe(null);
    expect(chipFor('public', { ...d, hero_headline: 'Climb more' })).toBe(null);
  });
});

describe('unreviewed surfaces', () => {
  it('returns the surfaces never opened while creating a type', () => {
    const unreviewed = unreviewedSurfaces({ editingExisting: false, visited: ['setup'] });
    expect(unreviewed.map(s => s.id)).toEqual(['email', 'public']);
    expect(unreviewed[0].label).toBe('Email');
  });

  it('returns nothing once every surface has been opened', () => {
    expect(unreviewedSurfaces({ editingExisting: false, visited: ['setup', 'email', 'public'] }))
      .toEqual([]);
  });

  // Routine edits must not be nagged, however little of the form was visited.
  it('returns nothing when editing an existing type, whatever was visited', () => {
    expect(unreviewedSurfaces({ editingExisting: true, visited: [] })).toEqual([]);
    expect(unreviewedSurfaces({ editingExisting: true, visited: ['setup'] })).toEqual([]);
  });

  it('carries the label the guard needs, so the caller need not look it up', () => {
    expect(unreviewedSurfaces({ editingExisting: false, visited: ['setup', 'email'] }))
      .toEqual([{ id: 'public', label: 'Public page' }]);
  });
});

describe('backdrop fallback', () => {
  // Must reproduce the public page's own gradient (voucher-site index.html):
  //   linear-gradient(135deg, #1C121B, var(--accent) 55%, var(--accent-dark))
  // where --accent-dark is shade(accent, -0.3) — every channel x 0.7.
  it('emits the public page gradient for the given accent', () => {
    expect(backdropFallbackCss('#ae222a')).toBe(
      'linear-gradient(135deg, #1C121B, #ae222a 55%, color-mix(in srgb, #ae222a 70%, black))');
  });

  // Expressed as a colour-mix, NOT a hex the editor computed itself: a fourth
  // hand-written darkening is exactly what would drift from the other three.
  it('expresses the dark stop as a colour-mix of the accent, not a computed hex', () => {
    const css = backdropFallbackCss('#123456');
    expect(css).toContain('color-mix(in srgb, #123456 70%, black)');
    expect(css).not.toMatch(/#0c243|#0d243c/i);
  });

  // The colour input can be empty on a draft that has never been saved.
  it('falls back to the house accent when none is set', () => {
    expect(DEFAULT_ACCENT).toBe('#ae222a');
    expect(backdropFallbackCss('')).toContain(DEFAULT_ACCENT);
    expect(backdropFallbackCss(null)).toContain(DEFAULT_ACCENT);
  });
});

// The rule renders in two places and must stay ONE string. Two hand-typed
// copies is how the previous guidance drifted — the help bubble ended up
// naming a band the page never cropped to — so "defined once, hero only" is
// checked here rather than left to review.
describe('the hero artwork composition rule', () => {
  it('names the band, both narrow surfaces, and what happens below it', () => {
    expect(HERO_ARTWORK_COMPOSITION_RULE).toBe(
      'Keep faces, logos and any words in the top 57% of your image — phones and '
      + 'the emailed voucher show only that band, and everything below it is '
      + 'cropped away.');
  });

  // The upload advisory shares this phrase deliberately, so a future surface
  // change greps to both. Asserted on index.html because that is the copy the
  // shared phrase could drift away from.
  it('shares its wording with the upload advisory', () => {
    expect(indexHtml()).toContain("so it'll look soft on phones and in the emailed voucher");
  });

  it('is not hand-copied into the editor', () => {
    expect(indexHtml()).not.toContain('top 57% of your image');
  });

  it('reaches the crop control and the picker from that one constant', () => {
    const html = indexHtml();
    expect(html).toContain('x-text="heroArtworkCompositionRule()"');
    expect(html).toContain('x-text="imgRoleInfo().rule"');
    expect(html).toMatch(/rule:\s*window\.typeSurfaces\?\.HERO_ARTWORK_COMPOSITION_RULE/);
  });

  // Both render sites hide themselves when the rule is missing. Without this the
  // editor would show a bolded "Composing artwork:" introducing nothing — which
  // is precisely the stale-cache case the optional chaining exists for.
  it('takes its lead-in with it when the constant cannot be read', () => {
    const html = indexHtml();
    expect(html).toContain('x-show="heroArtworkCompositionRule()"');
    expect(html).toContain('x-show="imgRoleInfo().rule"');
  });

  // The picker is shared between the two roles, and the backdrop has no
  // composition rule to state — it is `cover` against a content-height box.
  it('is carried by the hero role and not by the background role', () => {
    const roles = indexHtml().match(/const IMAGE_ROLES = \{([\s\S]*?)\n\s*\};/);
    expect(roles, 'could not find IMAGE_ROLES in index.html').toBeTruthy();
    const hero = roles[1].match(/hero:\s*\{([\s\S]*?)\}/)[1];
    const background = roles[1].match(/background:\s*\{([\s\S]*?)\}/)[1];
    expect(hero).toContain('rule:');
    expect(background).not.toContain('rule:');
  });
});

// The frames are the preview the rule describes. If they stop matching the
// surfaces they claim to show, the rule above is being read beside a lie.
describe('the hero crop frames', () => {
  it('anchors the narrow frame to the top, as the page and the email do', () => {
    // voucher-site renders aspect-[21/9] object-cover object-top on phones; the
    // email banner clips from the top and cannot move. A centred preview here
    // would point the opposite way to both.
    const html = indexHtml();
    const start = html.indexOf('aspect-[21/9]');
    expect(start, 'no 21:9 frame in the hero crop control').toBeGreaterThan(-1);
    const frame = html.slice(start, html.indexOf('</div>', start));
    expect(frame).toContain('object-cover object-top');
  });

  it('marks the discarded region on the 4:3 frame, at the 21:9 boundary', () => {
    const html = indexHtml();
    expect(html).toContain('top-[57.14%]');
    expect(html).toContain('Cut on phones &amp; email');
  });

  it('labels the two frames for the surfaces they show', () => {
    const html = indexHtml();
    expect(html).toContain('Desktop · 4:3');
    expect(html).toContain('Phone &amp; email · 21:9');
    // The backdrop's narrow frame carries no ratio: its box is content-height.
    expect(html).toContain('Desktop · 16:9');
    expect(html).not.toContain('Backdrop · 16:9');
  });
});
