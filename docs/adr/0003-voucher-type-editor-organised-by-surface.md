# ADR 0003 — The voucher type editor is organised by output surface

- **Status**: Accepted
- **Date**: 2026-08-07
- **Context**: voucher type editor tabs ([vouchers#42](https://github.com/urbanjungleirc/vouchers/issues/42))

## Context

A voucher type carries roughly 31 fields. They were laid out as five stacked
cards — Identity & rules, Email content, Branding, Public page, Staff — with a
live email preview pinned beside them for the whole scroll. Reaching Save meant
travelling about three screens.

The people who edit voucher types are not the people who built the form. Types
are configuration: created rarely, edited a few times a year, usually by a duty
manager who has not seen the form since the last time. Three things follow from
that.

The grouping existed visually but its *reason* did not. Nothing said that the
fields on screen governed the customer email while the ones two screens down
governed the public purchase page.

Half the modal was spent on a preview of one of those outputs. It reflects nine
fields. While the largest section — the public page — was being edited, it
showed an email unrelated to every keystroke, and the public page had no preview
at all.

And the brand colour, which themes the *entire* customer page, appeared once, in
a card the user had to scroll away from to edit the page it themes.

Underneath sat a discoverability problem with a real consequence: blank public
page fields inherit the Gift Voucher type's wording, and a cleared hero backdrop
becomes a gradient. Neither was stated anywhere, so a duty manager could save a
new type whose customer page silently borrowed another product's copy.

## Decision

**Group the fields by surface — the output they produce — and give each surface
a tab.**

| Surface | Cards | Preview |
|---|---|---|
| Setup | Identity & rules, Staff | none |
| Email | Email content, Branding | live email preview |
| Public page | Public page | none |

The partition is derived from what the code consumes, not from how the cards
happened to be grouped. The email renderer consumes exactly nine type columns,
and that is the Email tab's membership — which is why **Branding belongs to
Email**: all four of its fields feed the email renderer.

Three consequences of that boundary are worth stating, because each looks like
an inconsistency until the rule is known:

- **Brand colour is mirrored onto the Public page tab, not moved.** It themes
  the whole public page, so it must be visible while that page's copy is
  written — but it is shown read-only, with a button that jumps to the Email
  tab. A second editable control was rejected: binding two inputs to one value
  is nearly free, but presenting the same setting twice to someone who visits
  twice a year costs more than the saved click.
- **The staff redemption warning gets no surface of its own.** It is one field
  describing a redemption rule, so it sits with the other rules on Setup, as a
  visually distinct card.
- **The display name stays on Setup** despite feeding the email heading. The
  modal title renders it reactively, so it is on screen and live whichever tab
  is active.

The partition is **exported as data** from `vouchers/type-surfaces.js`, so the
branding-belongs-to-email decision is answerable by reading one constant rather
than by scanning markup. The same module holds the derivations over a draft
type: chip state, unreviewed surfaces, and the backdrop fallback CSS.

Panels are shown and hidden, never created and destroyed. Form state therefore
survives tab switching, one `@input` handler still covers every field, and chip
state is computable from the form model at any moment.

## Consequences

**A long scroll had one accidental virtue.** Reaching Save meant passing every
field, so nobody creating a type could avoid noticing that a public page section
existed. Tabs remove that, and without compensation this change would make it
*easier* to publish an unconfigured customer page.

Two things buy that property back, and they are load-bearing rather than
decorative:

- A **chip** on a tab, present only while that surface is untouched, naming what
  the customer gets instead ("Inherits Gift Voucher", "Default wording"). Setup
  never carries one — its identity fields are required, so a permanent
  indicator would be noise. The pre-filled email defaults
  (`redemption_instructions`, `voucher_label`) do not count as customisation; if
  they did, every type would read as customised forever.
- A **save guard on creation only**. If a surface was never opened, saving a new
  type asks first, and states the actual consequence. Editing an existing type
  never asks.

If either is dropped later, reopen this trade rather than accepting it quietly.

**The chip and the create path do not meet, and that is worth knowing.**
`openTypeEditor()` seeds a new draft from the live Gift Voucher record — it has
done so since long before this change. Those fields therefore arrive *populated*,
not blank, so on the create path neither chip appears: there is nothing to
inherit, because the type holds copies. The chip does its job on the edit path,
where types created before seeding (or through the API) genuinely carry nulls.

The spec's chip rule was written as "chip when the fields are blank", and that
is what shipped. Two consequences follow, both deliberate:

- The **save guard carries the whole weight on the create path**, which is the
  path the guard was written for. That is why its text says the unopened surface
  still holds *the Gift Voucher type's own wording and artwork* rather than the
  spec's "will use the Gift Voucher type's wording and show no hero artwork" —
  the latter describes the inheritance cascade, which a seeded type does not
  reach. Stating the cascade there would have been false.
- Making the chip mean "still identical to the Gift Voucher template" would give
  it a job on the create path too. It is a real option, it changes the rule the
  spec pinned down precisely, and it was **not** taken here. Reopen it as its own
  decision rather than folding it into a reorganisation.

Changing the seeding behaviour was not considered in scope.

**The chip is deliberately imprecise.** Theme inheritance is per field, so a
partially filled public page still inherits for the fields left blank, and the
chip will not say so; the two hero image fields do not inherit at all. A tab
label cannot carry that nuance. The guard text is where the real behaviour is
spelled out. This is a division of labour, not an oversight.

**A completion count was rejected.** It reads as a score and implies filling
every field is the goal. Blank is a legitimate configuration.

**The preview is now conditional, so it needs a dirty flag.** It refreshes only
while the Email tab is active. Because the display name lives on Setup and feeds
the email heading, entering the Email tab re-renders once if anything changed
while it was hidden. Without that, the preview would show a stale heading.

**The editor gains no colour maths.** The empty backdrop slot renders the real
fallback gradient using `color-mix(in srgb, <accent> 70%, black)` for the dark
stop. That is arithmetically identical to the `shade(accent, -0.3)` used by both
the public page and the email renderer, so a *fourth* hand-written darkening was
avoided and this one cannot drift from the others. The existing pair was left
alone — merging them is a separate job.

**No public page preview.** The email preview is server-rendered from the draft,
which is why it can show unsaved edits. The public page is a client-side
application that reads saved data only, so previewing a draft would need either
a second server-side renderer or a draft-injection channel spanning two
repositories. This decision compensates for its absence — the full modal width,
the page-mirroring field arrangement, and the brand colour swatch — rather than
providing it.

**Modal anatomy changed with it**: pinned header carrying title, error banner
and tab strip; scrolling body; pinned footer carrying Cancel and Save. That
fixes a pre-existing fault where Save sat below the fold on tall types, and it
keeps the error banner visible on any tab at any scroll position.

## Amendment — 2026-08-12 (#82)

The voucher email banner (#27) added `hero_image_url` to the email renderer
after this ADR was accepted. The renderer now consumes **ten** type columns, not
nine: `email.js:96` takes `heroImageUrl` and `email.js:171` renders it as the
banner across the top of the email.

The field nevertheless stays homed on the **Public page** surface. The
derivation rule — membership follows what the code consumes — yields here to a
named exception.

The brand colour is mirrored onto Public page because that tab has **no
preview**; the mirror was the only way to see the colour while writing the page
it themes. That rationale does not transfer. The Email tab *does* have a
preview, `previewVoucherType()` passes `hero_image_url` from the draft
(`index.js:799`), and the picker refreshes it across tabs (`applyImage()` →
`refreshPreview()` → the dirty re-render in `setTypeTab()`). A staff member on
the Email tab already sees the banner, live, so a read-only mirror would
duplicate the preview sitting beneath it.

`hero_background_url` is genuinely public-page-only and stays with Public page,
so the field group does not split.

The Email tab's membership is therefore "the nine columns homed here", not
"everything the renderer consumes". If that sentence is ever re-derived from the
code, this exception is why the tenth column is missing.
