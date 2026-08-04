import { describe, it, expect } from 'vitest';
import {
  ROLE_TARGETS, ABSURD_BYTES, SOFT_BUDGET_BYTES, HARD_CAP_BYTES, ACCEPTED_TYPES,
  planResize, tooLargeToProcess, isTooSmall, overSoftBudget, overHardCap, formatBytes,
  isAcceptedType, resizeImage,
} from '../image-pipeline.js';

const KB = 1024;
const MB = 1024 * 1024;

describe('ROLE_TARGETS', () => {
  // Derived from the customer page CSS, not guessed: the hero's largest
  // rendered size is 576 CSS px on MOBILE (max-w-xl); desktop is smaller.
  // 1200 is just over 2x for retina.
  it('targets 1200x900 for hero and 1920x1080 for background', () => {
    expect(ROLE_TARGETS.hero).toMatchObject({ width: 1200, height: 900 });
    expect(ROLE_TARGETS.background).toMatchObject({ width: 1920, height: 1080 });
  });
});

describe('planResize', () => {
  it('returns null when the image is already at or under target', () => {
    expect(planResize({ role: 'hero', width: 1200, height: 900 })).toBe(null);
    expect(planResize({ role: 'hero', width: 800, height: 600 })).toBe(null);
  });

  it('scales a large image down to fit the target box, preserving aspect', () => {
    expect(planResize({ role: 'hero', width: 4000, height: 3000 }))
      .toEqual({ width: 1200, height: 900 });
  });

  it('fits by the constraining dimension for a wide image', () => {
    // 4000x1000 (4:1) into a 1200x900 box -> width binds.
    expect(planResize({ role: 'hero', width: 4000, height: 1000 }))
      .toEqual({ width: 1200, height: 300 });
  });

  it('fits by height for a tall image', () => {
    // 1000x4000 into 1200x900 -> height binds.
    expect(planResize({ role: 'hero', width: 1000, height: 4000 }))
      .toEqual({ width: 225, height: 900 });
  });

  it('uses the background target for the background role', () => {
    expect(planResize({ role: 'background', width: 3840, height: 2160 }))
      .toEqual({ width: 1920, height: 1080 });
  });

  it('rounds to whole pixels', () => {
    const out = planResize({ role: 'hero', width: 3333, height: 2222 });
    expect(Number.isInteger(out.width)).toBe(true);
    expect(Number.isInteger(out.height)).toBe(true);
  });
});

describe('thresholds', () => {
  it('flags absurd inputs at 20 MB so a browser tab does not fall over', () => {
    expect(ABSURD_BYTES).toBe(20 * MB);
    expect(tooLargeToProcess(21 * MB)).toBe(true);
    expect(tooLargeToProcess(5 * MB)).toBe(false);
  });

  it('sets the soft conversion budget at 400 KB', () => {
    expect(SOFT_BUDGET_BYTES).toBe(400 * KB);
    expect(overSoftBudget(880 * KB)).toBe(true);
    expect(overSoftBudget(110 * KB)).toBe(false);
  });

  it('sets the hard cap at 2 MB, matching the Worker', () => {
    expect(HARD_CAP_BYTES).toBe(2 * MB);
    expect(overHardCap(2 * MB + 1)).toBe(true);
    expect(overHardCap(2 * MB)).toBe(false);
  });

  // Staff cannot perceive softness on a desktop preview, but every phone
  // user will — hence a warning rather than silence.
  it('warns below 1000 px wide for hero and 1400 px for background', () => {
    expect(isTooSmall({ role: 'hero', width: 640 })).toBe(true);
    expect(isTooSmall({ role: 'hero', width: 1200 })).toBe(false);
    expect(isTooSmall({ role: 'background', width: 1200 })).toBe(true);
    expect(isTooSmall({ role: 'background', width: 1920 })).toBe(false);
  });

  // Dimensions are NEVER a hard reject — object-cover copes with any aspect,
  // so a wrong shape is an aesthetic problem, not a broken page.
  it('has no function that rejects on dimensions', async () => {
    const mod = await import('../image-pipeline.js');
    expect(Object.keys(mod)).not.toContain('rejectOnDimensions');
  });
});

// Format IS a hard reject, unlike dimensions. The file input's `accept`
// attribute does not apply to drag-and-drop, and resizeImage hands back the
// original bytes when nothing needs doing — so without a guard here a dropped
// SVG would reach the Worker untouched and fail there instead.
describe('isAcceptedType', () => {
  it('accepts exactly PNG, JPEG and WebP', () => {
    expect(ACCEPTED_TYPES).toEqual(['image/png', 'image/jpeg', 'image/webp']);
    expect(isAcceptedType('image/png')).toBe(true);
    expect(isAcceptedType('image/jpeg')).toBe(true);
    expect(isAcceptedType('image/webp')).toBe(true);
  });

  // SVG on security grounds (it can carry <script>, served same-origin from
  // the Worker that also serves staff endpoints), GIF on taste.
  it('refuses SVG and GIF', () => {
    expect(isAcceptedType('image/svg+xml')).toBe(false);
    expect(isAcceptedType('image/gif')).toBe(false);
  });

  it('refuses non-images and a missing type', () => {
    expect(isAcceptedType('application/pdf')).toBe(false);
    expect(isAcceptedType('')).toBe(false);
    expect(isAcceptedType(undefined)).toBe(false);
    expect(isAcceptedType(null)).toBe(false);
  });

  // Browsers are inconsistent about case; a file is not unsupported merely
  // because its type arrived shouted.
  it('is case- and whitespace-insensitive', () => {
    expect(isAcceptedType('IMAGE/PNG')).toBe(true);
    expect(isAcceptedType(' image/jpeg ')).toBe(true);
  });
});

describe('resizeImage refuses unsupported formats before touching the file', () => {
  // This test runs with no DOM at all. That it rejects with the copy below
  // rather than a canvas/createImageBitmap error is the proof that the guard
  // fires before any decode or upload work happens.
  it('rejects an SVG with advisory Australian English copy', async () => {
    await expect(resizeImage({ type: 'image/svg+xml', size: 1024 }, { role: 'hero' }))
      .rejects.toThrow('That file type is not supported. Please use a PNG, JPEG or WebP image.');
  });

  it('rejects a file with no type at all', async () => {
    await expect(resizeImage({ size: 1024 }, { role: 'hero' }))
      .rejects.toThrow(/not supported/);
  });

  it('lets an accepted type past the guard', async () => {
    // No DOM here, so it must fail LATER, at decode — not at the guard.
    await expect(resizeImage({ type: 'image/png', size: 1024 }, { role: 'hero' }))
      .rejects.not.toThrow(/not supported/);
  });
});

describe('formatBytes', () => {
  it('renders KB below a megabyte and MB above', () => {
    expect(formatBytes(880 * KB)).toBe('880 KB');
    expect(formatBytes(2.4 * MB)).toBe('2.4 MB');
  });
});
