// How the voucher type editor is organised: by SURFACE — the output a group
// of fields actually produces — rather than by how the cards happen to be
// grouped.
//
// Three surfaces. Setup produces nothing customer-facing; Email is everything
// that renders into the customer's voucher email; Public page is everything
// that renders onto the public purchase page. Branding sits with Email because
// all four of its fields feed the email renderer — the accent colour also
// themes the public page, which is handled by mirroring it read-only on that
// tab rather than by moving the card.
//
// Kept out of index.html so the rules are testable without a browser. See
// docs/adr/0003-voucher-type-editor-organised-by-surface.md

export const SURFACES = [
  {
    id: 'setup',
    label: 'Setup',
    // Identity, rules, limits, and the staff redemption warning. The display
    // name feeds the email heading but stays here: the modal title renders it
    // reactively, so it is on screen whichever tab is active.
    fields: [
      'type_id', 'display_name', 'description',
      'availability', 'revenue_class', 'expiry_months', 'max_per_customer',
      'limit_period', 'promo_id', 'sort_order',
      'is_physical', 'is_active',
      'redemption_warning',
    ],
    chip: null,          // never — identity fields are required, so it is always populated
  },
  {
    id: 'email',
    label: 'Email',
    // Exactly the nine columns the email renderer consumes.
    fields: [
      'email_subject', 'email_body', 'terms_conditions', 'usage_info',
      'redemption_instructions',
      'accent_color', 'voucher_label', 'show_qr', 'show_value',
    ],
    chip: 'Default wording',
  },
  {
    id: 'public',
    label: 'Public page',
    fields: [
      'hero_headline', 'hero_subheadline', 'hero_description', 'cta_label',
      'hero_image_url', 'hero_background_url',
      'features_heading', 'features_subheading', 'features_md',
    ],
    chip: 'Inherits Gift Voucher',
  },
];

// The free-text email fields that arrive BLANK on a new draft. The other two
// text fields on that surface (redemption_instructions, voucher_label) ship
// pre-filled, so counting them would make every type read as customised
// forever and the chip would never appear.
export const EMAIL_CUSTOMISABLE_FIELDS = [
  'email_subject', 'email_body', 'terms_conditions', 'usage_info',
];

export const PUBLIC_PAGE_FIELDS = SURFACES.find(s => s.id === 'public').fields;

// Which fields decide whether a surface counts as untouched. Setup is absent
// deliberately — see its `chip: null` above.
const UNTOUCHED_TEST_FIELDS = {
  email: EMAIL_CUSTOMISABLE_FIELDS,
  public: PUBLIC_PAGE_FIELDS,
};

// The house accent, matching blankTypeForm() and the payload default in
// saveVoucherType(). Exported so the editor's swatch reads it from here rather
// than inlining a fourth copy of the literal.
export const DEFAULT_ACCENT = '#ae222a';

export function surfaceOf(field) {
  const surface = SURFACES.find(s => s.fields.includes(field));
  return surface ? surface.id : null;
}

const isBlank = (v) => v === null || v === undefined || String(v).trim() === '';

// True when nothing on the surface has been customised, so the customer sees
// whatever the fallback produces.
export function isUntouched(surfaceId, draft) {
  const fields = UNTOUCHED_TEST_FIELDS[surfaceId];
  if (!fields) return false;
  return fields.every(f => isBlank(draft?.[f]));
}

// The chip text for a tab, or null when the surface has been customised (or
// never carries a chip). It names the consequence, not the state — a duty
// manager who visits twice a year learns what blank means from reading it.
export function chipFor(surfaceId, draft) {
  const surface = SURFACES.find(s => s.id === surfaceId);
  if (!surface || !surface.chip) return null;
  return isUntouched(surfaceId, draft) ? surface.chip : null;
}

// Surfaces the user never opened, for the save guard. Creation only: editing
// an existing type is a routine act and must not be nagged.
export function unreviewedSurfaces({ editingExisting, visited }) {
  if (editingExisting) return [];
  const seen = visited || [];
  return SURFACES
    .filter(s => !seen.includes(s.id))
    .map(s => ({ id: s.id, label: s.label }));
}

// The gradient the public page draws when no hero backdrop is set, so an empty
// backdrop slot can show the real thing rather than describing it.
//
// The dark stop is a colour-mix rather than a hex this module computed: 70% of
// the accent mixed with black is arithmetically identical to the shade(accent,
// -0.3) used by both the public page and the email renderer, so the editor
// gains no colour maths of its own and cannot drift from them.
export function backdropFallbackCss(accent) {
  const c = isBlank(accent) ? DEFAULT_ACCENT : String(accent).trim();
  return `linear-gradient(135deg, #1C121B, ${c} 55%, color-mix(in srgb, ${c} 70%, black))`;
}
