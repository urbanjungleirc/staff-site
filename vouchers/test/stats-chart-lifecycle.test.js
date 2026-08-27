import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';

// The stats page draws four Chart.js charts. Three properties keep them on
// screen, and all three are invisible in review — each one, broken, produces the
// same symptom: cards that flash and then sit blank until a reload. They live
// inline in stats.html where no unit test can call them, so they are pinned
// against the page source. See vouchers#69.

const page = readFileSync(new URL('../stats.html', import.meta.url), 'utf8');

// The bootstrap-once half of vouchers#69 lives in single-bootstrap.test.js now:
// it is the same defect on every page of the site, so it is pinned once there
// rather than repeated per file.

describe('a redraw never releases a canvas', () => {
  test('nothing destroys a chart', () => {
    // Chart.js runs every animating chart through one shared rAF loop. A chart
    // destroyed while it still has animations queued stays in that loop, which
    // then calls draw() on the canvas it just released; the exception escapes
    // mid-iteration and kills the loop for EVERY chart on the page, with
    // nothing to restart it. One fast re-render blanked all four cards.
    expect(page).not.toMatch(/\.destroy\(\)/);
  });

  test('paint() updates the chart already on that canvas', () => {
    const paint = page.slice(page.indexOf('paint(key, canvas, config) {'));
    const body = paint.slice(0, paint.indexOf('\n      },'));
    // Canvas identity, not mere presence — a chart whose canvas has gone would
    // otherwise be reused to draw into nothing.
    expect(body).toMatch(/chart\.canvas === canvas/);
    expect(body).toMatch(/chart\.update\(\)/);
    expect(body).toMatch(/new Chart\(canvas, config\)/);
  });

  test('every chart goes through paint()', () => {
    const created = [...page.matchAll(/new Chart\(/g)].length;
    expect(created).toBe(1);            // the one inside paint()
    for (const key of ['money', 'liability', 'redeemed', 'cohort']) {
      expect(page).toMatch(new RegExp(`this\\.paint\\('${key}',`));
    }
  });

  test('clearing the charts empties them instead, without animating', () => {
    const blank = page.slice(page.indexOf('blankCharts() {'));
    const body = blank.slice(0, blank.indexOf('\n      },'));
    expect(body).toMatch(/datasets: \[\]/);
    // 'none' queues nothing for the shared loop.
    expect(body).toMatch(/update\('none'\)/);
  });

  test('both teardown paths use it', () => {
    // The empty window, and a refetch that failed — the second must still drop
    // the stale slice, or the page shows one filter bar describing another.
    const draw = page.slice(page.indexOf('      draw() {'));
    expect(draw.slice(0, 400)).toMatch(/if \(!this\.hasRows\(\)\) \{\s*\n\s*this\.blankCharts\(\);/);
    const load = page.slice(page.indexOf('async load() {'), page.indexOf('// ── Shaping'));
    expect(load).toMatch(/this\.data = null;\s*\n\s*this\.blankCharts\(\);/);
  });
});

describe('the chart instances stay out of Alpine', () => {
  test('they live in the factory closure, not on the component', () => {
    // Alpine deep-proxies everything the component holds, and Chart.js
    // resolving its options through that proxy recurses until the stack gives
    // out — a hard crash on the first in-place update.
    expect(page).toMatch(/\n    const charts = \{\};/);
    const returned = page.slice(page.indexOf('    return {\n      WORKER,'));
    expect(returned.slice(0, 600)).not.toMatch(/^\s*charts: \{\},$/m);
  });
});
