// Client-side image pipeline for the voucher type editor.
//
// The size cap bounds the STORED RESULT, not the upload: a 4000 px image
// destined for a 576 px box is downscaled automatically, with no prompt,
// because there is no judgement call in shrinking it. The one place human
// judgement earns an interruption is format conversion — auto-converting
// everything to JPEG would wreck flat-colour graphics and transparency.
//
// These decisions are separated from the canvas work so they are testable
// without a DOM. See
// voucher-app/docs/superpowers/specs/2026-08-03-staff-uploadable-voucher-type-images-design.md

const KB = 1024;
const MB = 1024 * 1024;

// Targets derived from the customer page CSS. The hero's largest rendered
// size is 576 CSS px ON MOBILE (max-w-xl); desktop is smaller (w-[30rem] /
// w-[34rem]). 1200 is just over 2x, so it stays crisp on retina.
//
// The hero is cropped to TWO shapes — aspect-[21/9] on mobile, aspect-[4/3]
// on desktop. Supplying the taller 4:3 means object-cover matches width and
// crops height for the mobile box, so neither breakpoint upscales.
export const ROLE_TARGETS = {
  hero:       { width: 1200, height: 900,  minWidth: 1000 },
  background: { width: 1920, height: 1080, minWidth: 1400 },
};

export const ABSURD_BYTES = 20 * MB;
export const SOFT_BUDGET_BYTES = 400 * KB;
export const HARD_CAP_BYTES = 2 * MB;

// PNG, JPEG and WebP only, matching the Worker's magic-byte sniffer. SVG is
// refused on security grounds (it can carry <script> and would be served
// same-origin from the Worker that also serves staff endpoints); GIF on
// taste. Keep this list in step with the Worker — it ships to a different
// repo, so it cannot be imported.
export const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

// null means "already small enough — leave it alone".
export function planResize({ role, width, height }) {
  const target = ROLE_TARGETS[role];
  if (!target || !width || !height) return null;
  if (width <= target.width && height <= target.height) return null;

  const scale = Math.min(target.width / width, target.height / height);
  return {
    width: Math.round(width * scale),
    height: Math.round(height * scale),
  };
}

export function tooLargeToProcess(bytes) { return bytes > ABSURD_BYTES; }
export function overSoftBudget(bytes)    { return bytes > SOFT_BUDGET_BYTES; }
export function overHardCap(bytes)       { return bytes > HARD_CAP_BYTES; }

export function isTooSmall({ role, width }) {
  const target = ROLE_TARGETS[role];
  return Boolean(target) && width < target.minWidth;
}

// Format is the one thing that IS a hard reject — unlike dimensions, an
// unsupported type cannot be salvaged, and the Worker would refuse it after
// a pointless round trip.
export function isAcceptedType(type) {
  return ACCEPTED_TYPES.includes(String(type || '').toLowerCase().trim());
}

export function formatBytes(bytes) {
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${Math.round(bytes / KB)} KB`;
}

// ── Canvas glue (browser only) ──────────────────────────────────────────────

// Decodes, downscales if needed, and re-encodes. Format is PRESERVED by
// default; pass mimeType to convert (that is the soft-budget prompt's job).
//
// The format guard lives here rather than only in the caller because the
// file input's `accept` attribute does not apply to drag-and-drop, and the
// no-resize-no-convert path below hands back the ORIGINAL bytes — so without
// this, a dropped SVG would sail through to the Worker untouched.
export async function resizeImage(file, { role, mimeType = null, quality = 0.85 } = {}) {
  if (!isAcceptedType(file?.type)) {
    throw new Error('That file type is not supported. Please use a PNG, JPEG or WebP image.');
  }

  const bitmap = await createImageBitmap(file);
  const plan = planResize({ role, width: bitmap.width, height: bitmap.height });
  const width = plan ? plan.width : bitmap.width;
  const height = plan ? plan.height : bitmap.height;

  // No resize and no conversion asked for: hand back the original bytes
  // untouched rather than round-tripping them through a canvas.
  if (!plan && !mimeType) {
    bitmap.close?.();
    return { blob: file, width, height };
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  const type = mimeType || file.type || 'image/png';
  const blob = await new Promise(r => canvas.toBlob(r, type, quality));
  return { blob, width, height };
}
