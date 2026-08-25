import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';

// Every script the voucher pages load from someone else's server, pinned as a
// list. The point is not the list — it is that adding to it has to be a
// deliberate edit here, with a human checking the URL actually resolves.
//
// This exists because of #139. The hub loaded
// cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js, which 404s: that
// version of the package ships no build/ directory at all. Nothing broke
// loudly — the script simply never arrived, and the dead code behind it
// (renderQr, qrDataUrl) had already lost its markup in 9b28f87 two months
// earlier, so there was nothing on screen to notice was missing.
//
// These tests do NOT fetch anything. A test that hits the network fails on a
// flaky connection and passes on a warm cache, which is the opposite of what
// this needs to be.

const PAGES = ['index.html', 'stats.html', 'unsubscribes.html'];

// url -> why it is here. Checked live on 2026-08-25.
const ALLOWED = {
  'https://cdn.tailwindcss.com': 'Tailwind Play CDN — the pages have no build step',
  'https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js': 'Alpine, the component runtime',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js': 'Chart.js, stats page only',
};

function externalUrls(file) {
  const html = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
  return [...html.matchAll(/<(?:script|link)\b[^>]*?(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
}

describe('third-party scripts', () => {
  for (const page of PAGES) {
    test(`${page} loads nothing unexpected`, () => {
      for (const url of externalUrls(page)) {
        expect(ALLOWED[url], `${page} loads an unlisted third-party URL: ${url}`).toBeDefined();
      }
    });
  }

  // The specific corpse from #139. Named so a copy-paste of the old tag from
  // git history, or from another repo, fails rather than silently 404ing.
  test('the dead qrcode CDN pin is gone for good', () => {
    for (const page of PAGES) {
      const html = readFileSync(new URL('../' + page, import.meta.url), 'utf8');
      expect(html).not.toContain('qrcode@1.5.3');
      expect(html).not.toContain('build/qrcode.min.js');
    }
  });

  // A version-pinned CDN path is the failure mode #139 was: the package still
  // exists, the version still exists, and the FILE does not. Keeping the list
  // small is the only real defence, so this fails loudly if it grows.
  test('the list stays short enough to check by hand', () => {
    expect(Object.keys(ALLOWED)).toHaveLength(3);
  });
});

describe('the detail-view QR is gone, not half-gone', () => {
  // 9b28f87 removed the QR section from the detail view on purpose but left the
  // state, the method, the $nextTick that called it and the script tag behind.
  // Dead code that looks like a feature is what made #139 read as a broken QR
  // rather than as leftovers.
  const hub = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

  test('no leftovers of the removed QR remain', () => {
    for (const corpse of ['qrDataUrl', 'renderQr', 'QRCode']) {
      expect(hub).not.toContain(corpse);
    }
  });
});
