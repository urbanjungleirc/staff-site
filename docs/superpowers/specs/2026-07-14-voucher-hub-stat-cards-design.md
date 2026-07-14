# Voucher staff hub — combine the top stat cards

**Date:** 2026-07-14
**Repo:** `urbanjungleirc/staff-site` (`uj/staff-portal`)
**File:** `vouchers/index.html`
**Status:** Approved, ready to plan

## Problem

The Search view of the voucher staff hub opens with five separate stat cards in a
`grid-cols-2 sm:grid-cols-5` grid:

| Card | Field |
|------|-------|
| Active vouchers | `dashStats.active_count` |
| Total active value | `dashStats.active_total_value` |
| Expiring in 30 days | `dashStats.expiring_soon_count` |
| Issued today | `dashStats.today_issued` |
| Redeemed today | `dashStats.today_redeemed` |

Two problems with this:

1. **Five equal cards imply five equal questions.** They aren't. Three of them
   describe the outstanding book (how many vouchers are live, what they're worth,
   which ones are about to lapse); two describe today's activity. Related numbers
   sit in unrelated boxes, and the number that actually matters to the business —
   the dollar value outstanding — carries no more weight than "issued today".
2. **Five cards don't divide by two.** Below the `sm` breakpoint the grid is two
   columns, so the cards break 2 + 2 + 1 and the fifth is left orphaned on its own
   row at half width.

## Design

Merge the five cards into two, grouped by the question each one answers.

### Layout

The container stays a 5-column grid at `sm` and up. Instead of five one-column
cards it holds two:

- **Outstanding** — `sm:col-span-3` (~60%)
- **Today** — `sm:col-span-2` (~40%)

Below `sm`, both cards go full width and stack. No new grid machinery, and the
orphan row disappears.

```
┌──────────────────────────────────┐ ┌──────────────────┐
│ 🎫 OUTSTANDING                   │ │ 📅 TODAY         │
│                                  │ │                  │
│ $6,480                           │ │   3        2     │
│ across 142 active vouchers       │ │ issued  redeemed │
│ ──────────────────────────────── │ │                  │
│ ⚠ 7 expiring in the next 30 days │ │                  │
└──────────────────────────────────┘ └──────────────────┘
              ~60%                          ~40%
```

### Outstanding card

- **Header row** — existing `.stat-icon` + uppercase label, same treatment as the
  current card labels.
- **Hero** — `active_total_value` as `$6,480`, UJ accent, ~`text-3xl`. The dollar
  figure is the hero because it is the number the business cares about; the count
  is context for it.
- **Sub-line** — `across 142 active vouchers`, secondary weight. Singular-aware:
  one voucher reads "across 1 active voucher".
- **Divider** — hairline.
- **Expiring row** — `⚠ 7 expiring in the next 30 days` in amber when the count is
  above zero. When it is zero the row goes muted grey and reads *"No vouchers
  expiring in the next 30 days"* — a zero that says nothing is wrong, rather than a
  bare `0`.

### Today card

- **Header row** — same treatment.
- **Two figures side by side** — issued in neutral, redeemed in emerald. The
  existing colour coding is preserved so the meaning of each number doesn't move.

### Interactivity

Both cards become drill-downs into the view that explains them.

| Click target | Destination | Implementation |
|--------------|-------------|----------------|
| **Today** card (whole card) | Reports view, `today` tab | `reportTab = 'today'; goReport()` |
| **Outstanding** card body (header + hero + sub-line) | Search view, filtered to Active | `q = ''; statusFilter = 'active'; search()` |
| Expiring row | *(none — see below)* | deferred |

Both destinations already exist and need no backend work: the Reports view is
driven by `reportTab` (`today` / `week` / `month`) and `goReport()` loads whichever
tab is set, and Search already filters on `status=active`.

**The expiring row is deliberately not clickable.** There is no `expiring_soon`
filter on the search API — `expiring_soon_count` arrives only as a number on the
stats payload. Making that row a drill-down needs a new filter in the payments
Worker and the Supabase query, which turns this frontend tweak into a backend
change. Logged as a follow-up; out of scope here.

Markup and affordances:

- Click targets are real `<button>` elements, not `@click` on a `<div>`, so they
  are keyboard-reachable and announced correctly.
- **The Outstanding card's button wraps only the header, hero, and sub-line — not
  the whole card.** The expiring row is a non-interactive sibling inside the same
  card. Wrapping the entire card would swallow that row into a click target that
  goes somewhere the row doesn't mean.
- Each interactive region gets a hover state, a visible `focus-visible` ring, and a
  chevron/arrow affordance in the header row so it reads as clickable at rest.
- The non-interactive expiring row keeps a default cursor and no hover state, so
  the difference is legible.

### Loading skeleton

The current skeleton renders `x-for="i in 5"` pulse cards. It must change with the
layout, or the page flashes five grey boxes and then snaps to two. It becomes two
skeleton cards on the same 3 / 2 spans.

## Wording decision: "Outstanding", not "liability"

The card is labelled **Outstanding** and the sub-line says **active vouchers** —
deliberately *not* "liability".

`vouchers/stats.html` already has a liability tile, and its figure is computed
differently from `active_total_value`. Reusing the word here would imply the two
numbers should agree when they don't, and would re-open the overstatement
confusion that tile has already caused once.

## Out of scope

- No change to the Worker, Supabase, or the `dashStats` payload. All five fields
  already arrive; only the markup that renders them changes. Both drill-down
  destinations reuse existing frontend state (`reportTab`, `statusFilter`).
- No change to `vouchers/stats.html`.

## Follow-up

Two items, both blocked on the same backend gap — the voucher search endpoint.
They belong together in one piece of work.

1. **Expiring-soon drill-down.** The expiring row can't link anywhere until an
   `expiring_soon` filter exists on the search endpoint (payments Worker + Supabase
   query). It's the row most likely to prompt staff action, so it's worth doing.

2. **The Outstanding card can over-promise.** The search endpoint caps results at
   100. Click a card reading "142 active vouchers" and you land on a list of 100,
   under a banner advising you to *"narrow your search by name, email, or voucher
   code"* — advice that makes no sense to someone who arrived by clicking a card
   rather than typing a search. This is an inherited limitation (staff already hit
   it by picking "Active" and pressing Search), but the card promotes it to a
   one-click path and makes the shortfall visible. It needs paging or a raised cap
   on the endpoint; a frontend-only patch just swaps one misleading message for
   another, since the full 142 still aren't fetched.

## Verification

- Desktop ≥ `sm`: two cards, 60/40 split, no orphan row.
- Mobile < `sm`: two stacked full-width cards.
- `expiring_soon_count = 0`: muted "No vouchers expiring…" row, not an amber `0`.
- `active_count = 1`: sub-line reads "across 1 active voucher".
- Loading: two pulse skeletons matching the final spans; no five-to-two flash.
- Clicking the Today card lands on Reports with the `today` tab active and its data
  loaded.
- Clicking the Outstanding card body lands on Search with the status filter showing
  "Active" and results listed.
- Both click targets are reachable by <kbd>Tab</kbd> and fire on <kbd>Enter</kbd>,
  with a visible focus ring.
- The expiring row does not respond to hover, click, or keyboard focus.
