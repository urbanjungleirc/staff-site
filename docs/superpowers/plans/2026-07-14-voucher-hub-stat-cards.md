# Voucher Hub Stat Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the five stat cards at the top of the voucher staff hub's Search view with two grouped, clickable cards — Outstanding (60%) and Today (40%).

**Architecture:** Pure frontend change to one static HTML file. The five `dashStats` fields already arrive from `/v1/vouchers/stats`; only the markup that renders them changes. Both drill-downs reuse frontend state that already exists (`reportTab` for Reports, `statusFilter` for Search), so no Worker, Supabase, or API work is needed.

**Tech Stack:** Static HTML + Alpine.js 3 (CDN) + Tailwind (CDN) + hand-written CSS in a `<style>` block. No build step, no bundler.

**Spec:** `docs/superpowers/specs/2026-07-14-voucher-hub-stat-cards-design.md`

## Global Constraints

- **One file only:** `vouchers/index.html`. No other file in the repo changes.
- **No backend change.** Do not touch `cloudflare-payments-proxy/`, the `uj-payments` Worker, or any Supabase migration. If a step seems to need one, stop — it's out of scope.
- **The word "liability" must not appear** in any label or copy added here. The card is **Outstanding**; the sub-line says **active vouchers**. `vouchers/stats.html` has a liability tile computed differently, and the two figures must not look like they should agree.
- **The expiring row is NOT a click target.** No search API filter exists for it. It stays a plain, non-interactive line.
- **Match local style.** This file uses Tailwind utility classes inline, Alpine `x-` directives, and custom classes (`.stat-card`, `.stat-icon`, `.hub-card`) defined in the `<style>` block near the top. Follow that; do not introduce a framework, a build step, or a CSS file.
- **Colour coding is preserved:** issued = neutral, redeemed = emerald, expiring = amber, money/accent = `text-uj`.

## No test harness — how verification works

This repo has **no JS test framework for the static pages** (the only tests are `cloudflare-payments-proxy/test/proxy.test.js`, for the Worker). There is nothing to write a failing unit test against, so the usual red-green TDD cycle does not apply here.

Instead, **every task is verified in a real browser against injected fixture state**, which exercises the actual rendered DOM. The page is behind Cloudflare Access in production and its API is unreachable locally, so we drive Alpine's state directly rather than the network.

Set the harness up once (Task 1, Step 1) and reuse it in every task:

```bash
# From the repo root: uj/staff-portal
npx serve . -l 5055
```

Then in the browser at `http://localhost:5055/vouchers/`, this snippet injects
fixture stats into the live Alpine component and forces the Search view:

```js
const d = Alpine.$data(document.querySelector('[x-data]'));
d.dashStatsLoading = false;
d.view = 'search';
d.dashStats = { active_count: 142, active_total_value: 6480, expiring_soon_count: 7, today_issued: 3, today_redeemed: 2 };
```

Vary that fixture per the checks in each task. Use the Playwright MCP tools
(`playwright_navigate`, `playwright_evaluate`, `playwright_screenshot`,
`playwright_click`, `playwright_press_key`, `playwright_resize`) to drive it.

---

### Task 1: Two-card layout

Replace the five cards with two, and fix the loading skeleton to match. No interactivity yet — this task is the layout and the data rendering only.

**Files:**
- Modify: `vouchers/index.html:468-505` (the `<!-- Summary stats -->` block)

**Interfaces:**
- Consumes: `dashStats` — `{ active_count, active_total_value, expiring_soon_count, today_issued, today_redeemed }` (all numbers), and `dashStatsLoading` (boolean). Both already exist on the Alpine component; do not rename them.
- Produces: the two-card markup that Task 2 attaches click handlers to.

- [ ] **Step 1: Start the local server and confirm the page loads**

```bash
cd uj/staff-portal
npx serve . -l 5055
```

Navigate to `http://localhost:5055/vouchers/`. Expect the page shell to render. The API calls will fail (no Access session locally) — that is fine and expected; we inject state manually.

- [ ] **Step 2: Replace the summary stats block**

Replace the whole block at `vouchers/index.html:468-505` (from `<!-- Summary stats -->` through its closing `</div>`) with:

```html
      <!-- Summary stats — two cards: the outstanding book, and today's activity -->
      <div class="mb-5">
        <div x-show="dashStatsLoading" class="grid grid-cols-1 sm:grid-cols-5 gap-3">
          <div class="stat-card rounded-[16px] p-4 sm:col-span-3 animate-pulse">
            <div class="h-[30px] w-[30px] bg-neutral-200/70 rounded-[10px] mb-3"></div>
            <div class="h-8 w-28 bg-neutral-200/80 rounded mb-2"></div>
            <div class="h-2.5 w-40 bg-neutral-100 rounded"></div>
          </div>
          <div class="stat-card rounded-[16px] p-4 sm:col-span-2 animate-pulse">
            <div class="h-[30px] w-[30px] bg-neutral-200/70 rounded-[10px] mb-3"></div>
            <div class="h-8 w-20 bg-neutral-200/80 rounded mb-2"></div>
            <div class="h-2.5 w-24 bg-neutral-100 rounded"></div>
          </div>
        </div>

        <div x-show="dashStats && !dashStatsLoading" class="grid grid-cols-1 sm:grid-cols-5 gap-3">

          <!-- Outstanding: what's on the book, and what's about to lapse -->
          <div class="stat-card rounded-[16px] sm:col-span-3 flex flex-col">
            <div class="p-4 pb-3">
              <div class="flex items-center gap-2 mb-3">
                <span class="stat-icon"><svg viewBox="0 0 24 24"><path d="M3.5 8.5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v2.1a2.4 2.4 0 0 0 0 4.8v2.1a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-2.1a2.4 2.4 0 0 0 0-4.8V8.5z"/><path d="M9 9.25v5.5"/></svg></span>
                <span class="text-[0.67rem] font-semibold text-neutral-400 uppercase tracking-wider">Outstanding</span>
              </div>
              <div class="text-3xl font-bold text-uj tabular-nums tracking-tight"
                x-text="'$' + Number(dashStats?.active_total_value ?? 0).toFixed(0)"></div>
              <div class="text-[0.8rem] text-neutral-500 mt-1"
                x-text="'across ' + (dashStats?.active_count ?? 0) + ' active voucher' + ((dashStats?.active_count ?? 0) === 1 ? '' : 's')"></div>
            </div>

            <div class="border-t border-[rgba(139,28,35,0.10)] mx-4"></div>

            <!-- Not a click target: there is no expiring-soon filter on the search API. -->
            <div class="px-4 py-3 text-[0.8rem] flex items-center gap-2"
              :class="(dashStats?.expiring_soon_count ?? 0) > 0 ? 'text-amber-600' : 'text-neutral-400'">
              <svg class="stat-inline-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="7.5"/><path d="M12 7.75v4.5l2.75 1.65"/></svg>
              <span x-show="(dashStats?.expiring_soon_count ?? 0) > 0">
                <strong class="font-semibold tabular-nums" x-text="dashStats?.expiring_soon_count ?? 0"></strong><span
                  x-text="(dashStats?.expiring_soon_count ?? 0) === 1 ? ' voucher expiring in the next 30 days' : ' vouchers expiring in the next 30 days'"></span>
              </span>
              <span x-show="(dashStats?.expiring_soon_count ?? 0) === 0">No vouchers expiring in the next 30 days</span>
            </div>
          </div>

          <!-- Today: what happened on the counter -->
          <div class="stat-card rounded-[16px] p-4 sm:col-span-2">
            <div class="flex items-center gap-2 mb-3">
              <span class="stat-icon"><svg viewBox="0 0 24 24"><path d="M7 3.75v3"/><path d="M17 3.75v3"/><rect x="4" y="5.5" width="16" height="14" rx="2"/><path d="M4 10h16"/></svg></span>
              <span class="text-[0.67rem] font-semibold text-neutral-400 uppercase tracking-wider">Today</span>
            </div>
            <div class="flex items-start gap-7">
              <div>
                <div class="text-2xl font-bold text-neutral-700 tabular-nums tracking-tight" x-text="dashStats?.today_issued ?? 0"></div>
                <div class="text-[0.67rem] font-semibold text-neutral-400 uppercase tracking-wider mt-1">Issued</div>
              </div>
              <div>
                <div class="text-2xl font-bold text-emerald-600 tabular-nums tracking-tight" x-text="dashStats?.today_redeemed ?? 0"></div>
                <div class="text-[0.67rem] font-semibold text-neutral-400 uppercase tracking-wider mt-1">Redeemed</div>
              </div>
            </div>
          </div>

        </div>
      </div>
```

- [ ] **Step 3: Add the inline icon style**

The expiring row's SVG is not inside a `.stat-icon` wrapper, so it inherits no sizing. Add this to the `<style>` block, immediately after the `.stat-icon.warning { … }` rule that ends at `vouchers/index.html:204`:

```css
    /* Bare inline icon (not in a .stat-icon tile) — takes its colour from the parent. */
    .stat-inline-icon {
      width: 15px;
      height: 15px;
      flex-shrink: 0;
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
```

- [ ] **Step 4: Verify the populated state**

Reload `http://localhost:5055/vouchers/`, then evaluate:

```js
const d = Alpine.$data(document.querySelector('[x-data]'));
d.dashStatsLoading = false;
d.view = 'search';
d.dashStats = { active_count: 142, active_total_value: 6480, expiring_soon_count: 7, today_issued: 3, today_redeemed: 2 };
```

Screenshot at 1280px wide. Expected: **two** cards, not five. Left card ~60% wide reading `$6,480` in dark red with `across 142 active vouchers` beneath, a hairline divider, then an amber row `7 vouchers expiring in the next 30 days`. Right card ~40% wide with `3 Issued` and `2 Redeemed` (redeemed in green). No orphan card, no empty grid cell.

- [ ] **Step 5: Verify the zero and singular edge cases**

Evaluate:

```js
const d = Alpine.$data(document.querySelector('[x-data]'));
d.dashStats = { active_count: 1, active_total_value: 50, expiring_soon_count: 0, today_issued: 0, today_redeemed: 0 };
```

Expected: sub-line reads `across 1 active voucher` (singular, no trailing "s"). The expiring row is **grey**, not amber, and reads `No vouchers expiring in the next 30 days` — no bare `0`.

Then set `d.dashStats.expiring_soon_count = 1` and confirm it reads `1 voucher expiring in the next 30 days` (singular).

- [ ] **Step 6: Verify mobile stacking**

Resize the viewport to 390px wide. Expected: the two cards stack full-width, one above the other. No half-width orphan.

- [ ] **Step 7: Verify the loading skeleton**

Evaluate:

```js
const d = Alpine.$data(document.querySelector('[x-data]'));
d.dashStatsLoading = true;
```

Expected: **two** pulsing skeleton cards on the same 3 / 2 split — not five. Set `d.dashStatsLoading = false` and confirm the real cards return without the layout jumping from five boxes to two.

- [ ] **Step 8: Commit**

```bash
git add vouchers/index.html
git commit -m "feat(vouchers): merge the five dashboard stat cards into Outstanding + Today"
```

---

### Task 2: Make the cards drill down

Turn the Outstanding card body into a link to the active-voucher search, and the Today card into a link to today's report.

**Files:**
- Modify: `vouchers/index.html` — the two-card markup from Task 1, the `<style>` block, and the Alpine component's method list (near `loadDashStats`, around line 2926)

**Interfaces:**
- Consumes (all already exist on the component — do not rename or re-declare):
  - `q` (string), `statusFilter` (string), `search()` (async; sets `view = 'search'` itself)
  - `reportTab` (string: `'today'` | `'week'` | `'month'`), `goReport()` (async; sets `view = 'report'` and calls `loadReport()`)
- Produces: two new methods, `showActiveVouchers()` and `showTodayReport()`.

- [ ] **Step 1: Add the two drill-down methods**

Insert immediately **before** `async loadDashStats() {` (currently `vouchers/index.html:2926`):

```js
      // ── Dashboard drill-downs ────────────────────────────────────────────
      // The summary cards link to the view that explains the number they show.
      async showActiveVouchers() {
        this.q = '';
        this.statusFilter = 'active';
        await this.search();   // search() switches to the Search view itself
      },

      async showTodayReport() {
        this.reportTab = 'today';
        await this.goReport();
      },

```

- [ ] **Step 2: Add the clickable-region styles**

Add to the `<style>` block, immediately after the `.stat-card { … }` rule that ends at `vouchers/index.html:347`:

```css
    /* Clickable stat regions — drill into the view that explains the number. */
    .stat-action {
      display: block;
      width: 100%;
      text-align: left;
      cursor: pointer;
      transition: background-color 0.15s ease;
    }
    .stat-action:hover {
      background: rgba(139, 28, 35, 0.05);
    }
    .stat-action:focus-visible {
      outline: 2px solid var(--uj);
      outline-offset: -2px;
    }
    .stat-chevron {
      width: 16px;
      height: 16px;
      flex-shrink: 0;
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
      color: rgba(139, 28, 35, 0.35);
      transition: transform 0.15s ease, color 0.15s ease;
    }
    .stat-action:hover .stat-chevron {
      color: var(--uj);
      transform: translateX(2px);
    }
```

- [ ] **Step 3: Make the Outstanding card body a button**

In the Outstanding card, change the opening tag of the inner padded block from:

```html
            <div class="p-4 pb-3">
```

to:

```html
            <button type="button" @click="showActiveVouchers()" class="stat-action p-4 pb-3 rounded-t-[16px]">
```

and change its matching closing `</div>` (the one directly above the `border-t` divider) to `</button>`.

Then add the chevron to that button's header row — change:

```html
                <span class="text-[0.67rem] font-semibold text-neutral-400 uppercase tracking-wider">Outstanding</span>
```

to:

```html
                <span class="text-[0.67rem] font-semibold text-neutral-400 uppercase tracking-wider">Outstanding</span>
                <svg class="stat-chevron ml-auto" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>
```

**The button must wrap only the header, hero, and sub-line.** The divider and the expiring row stay outside it, as siblings inside the card. A card-wide button would swallow the expiring row into a click target that goes somewhere the row does not mean.

- [ ] **Step 4: Make the Today card a button**

Change the Today card's outer element from:

```html
          <div class="stat-card rounded-[16px] p-4 sm:col-span-2">
```

to:

```html
          <button type="button" @click="showTodayReport()" class="stat-card stat-action rounded-[16px] p-4 sm:col-span-2">
```

and its matching closing `</div>` to `</button>`.

Add the chevron to its header row — change:

```html
              <span class="text-[0.67rem] font-semibold text-neutral-400 uppercase tracking-wider">Today</span>
```

to:

```html
              <span class="text-[0.67rem] font-semibold text-neutral-400 uppercase tracking-wider">Today</span>
              <svg class="stat-chevron ml-auto" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>
```

- [ ] **Step 5: Verify the Today drill-down**

Reload, inject the fixture from the harness snippet, then click the Today card and evaluate:

```js
const d = Alpine.$data(document.querySelector('[x-data]'));
[d.view, d.reportTab];
```

Expected: `["report", "today"]`. The Reports view is on screen with its **Today** tab active (dark red pill). The report body will show a load error locally — that's the unreachable API, not a bug in this change.

- [ ] **Step 6: Verify the Outstanding drill-down**

Reload, inject the fixture, click the Outstanding card body (the hero number area), then evaluate:

```js
const d = Alpine.$data(document.querySelector('[x-data]'));
[d.view, d.statusFilter, d.q];
```

Expected: `["search", "active", ""]`. The status dropdown in the search form reads **Active**.

- [ ] **Step 7: Verify the expiring row is inert**

Hover the expiring row: expect **no** background change and a default (arrow) cursor, not a pointer. Click it: expect `view` to stay `'search'` and `statusFilter` to be unchanged. Confirm it is not a `<button>`:

```js
document.evaluate("//*[contains(text(),'expiring in the next 30 days')]", document, null, 9, null).singleNodeValue?.closest('button');
```

Expected: `null`.

- [ ] **Step 8: Verify keyboard access**

Reload and inject the fixture. Press <kbd>Tab</kbd> repeatedly from the top of the page. Expect both card buttons to receive focus in DOM order (Outstanding, then Today), each showing a visible dark-red focus ring. Press <kbd>Enter</kbd> on the focused Today card and confirm `view === 'report'`.

- [ ] **Step 9: Commit**

```bash
git add vouchers/index.html
git commit -m "feat(vouchers): drill down from the summary cards into Search and Reports"
```

---

### Task 3: Ship it

**Files:**
- No code change. This task is the pre-push check and the deploy.

- [ ] **Step 1: Re-read the diff**

```bash
git diff main -- vouchers/index.html
```

Confirm: only `vouchers/index.html` is touched; no backend file appears; the string `liability` does not appear anywhere in the added lines; the five old `stat-card` blocks are gone with no leftover fragments.

- [ ] **Step 2: Confirm nothing else on the page broke**

With the server still running, load `http://localhost:5055/vouchers/` and check the page's other views still switch and render: click **Create**, **Reports**, **Voucher Types** in the header nav. Expect each to render its view (API errors inside them are expected locally). This catches an unbalanced `<div>`/`<button>` tag, which in a 3,500-line file is the realistic failure mode of this change.

Also check the browser console for Alpine errors. Expected: none from the summary block.

- [ ] **Step 3: Push**

```bash
git push origin main
```

GitHub Pages publishes the static file. No Worker deploy is needed — nothing under `cloudflare-worker/` or `cloudflare-payments-proxy/` changed.

- [ ] **Step 4: Verify live**

Open `https://ujstaff.happyk.au/vouchers/` (through Cloudflare Access, so real data). Confirm both cards render with real numbers, the Today card opens today's report with data in it, and the Outstanding card opens the active-voucher search with results. This is the first check against real API data rather than fixtures.

---

## Follow-up (not in this plan)

Making the expiring row a drill-down needs an `expiring_soon` filter on the voucher search endpoint (payments Worker + Supabase query). It is the row most likely to prompt staff action, so it is worth doing — but it is a backend change and belongs in its own piece of work.
