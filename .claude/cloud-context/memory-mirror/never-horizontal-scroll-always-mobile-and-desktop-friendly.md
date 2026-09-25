---
name: never-horizontal-scroll-always-mobile-and-desktop-friendly
description: "Owner golden rule 2026-09-01 — no screen in Phoenix may ever scroll horizontally; every screen must fit both a phone and a desktop. Governs table design, so it outranks the min-width scroll containers the portal primitives default to."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 68c99353-0621-4944-bcd9-8d97b0e8c226
  modified: 2026-09-02T07:15:16.395Z
---

**GOLDEN RULE, owner 2026-09-01, in his own words: "Never horizontal screening, always mobile
friendly and desktop friendly."** He said it twice in one breath and asked for it to be recorded as
a golden word, which is how he marks a rule he does not want re-litigated.

The content must **fit the screen it is on**. Not "scroll to see the rest" — fit.

**Why:** he runs this business from a phone as much as a laptop, often late at night. A table that
side-scrolls hides its right-hand columns behind a gesture nobody makes, so the data is present and
unread — which is worse than absent, because the screen looks complete. He asked for an Address
column on Reps List that was **already there**, sitting off-screen behind 1120px of `min-width`.
That is the whole argument for the rule, and it is why he escalated it to golden rather than filing
it as a tweak.

**How to apply:**

- **Never `overflow-x-auto` with a `min-width` floor as the way to fit a table.** That pattern is
  what produces the scroll. `src/components/employee-portal/portal-primitives.tsx`'s
  `PortalDesktopTable` hard-codes `hidden overflow-x-auto md:block` and defaults `minWidth` to
  `980px`, so **a board bound by this rule must not use it** — render its own
  `<div className="hidden md:block">` with `<table className="w-full table-fixed">` and a
  `<colgroup>` instead. Reps List does exactly this
  (`src/components/crm/reps-list-tables.tsx`); copy that shape.
- **Fewer columns, stacked cells.** The way to fit is to merge, not to shrink. On Reps List he
  directed grade and phone under the contact **name in the same cell**, which retired two columns
  outright. Reach for that before reaching for a smaller font.
- **Measure the widths, do not guess them.** `table-fixed` percentages clip silently. At a 938px
  viewport the Reps List table had ~845px to share and the word "Pharmacist" plus padding needed
  104px of it — a 9% column clipped it by 4px with no visual warning. Verify in a browser with
  `el.scrollWidth > el.clientWidth` over `main`, at desktop **and** at 375px.
- **That `main` check is BLIND to a popover, and reports the page as perfect while one hangs off the
  side.** Measured on production 2026-09-02 (revision `803d74e13`): the nav row's "+" panel opened at
  `left: 184 → right: 472` in a **375px** viewport — ~97px off-screen, **clipped rather than
  scrollable**, so that strip was unreachable — and `main` and the document both read **375/375
  throughout**, because an ancestor clipped the overflow instead of scrolling it. So for anything
  absolutely positioned — a popover, a dropdown, a tooltip, a menu — **measure the ELEMENT's own
  `getBoundingClientRect()` against `document.documentElement.clientWidth`, with it OPEN.** The page
  passing is not evidence.
- **A panel anchored to a button cannot be placed in CSS, and narrowing it does not help** — the
  overflow comes from the anchor's x position, not the width, and **both edges are in play** (a
  top-row trigger sits near the right edge and overflows RIGHT; a lower-row one sits near the left, so
  right-anchoring or centring overflows LEFT). Compute the placement against a measured viewport:
  `clampPanelToViewport` in `src/lib/navigation/panel-position.ts`, pinned by
  `tests/nav-panel-position.test.ts`. Call it from the **click handler** — `setState` inside
  `useEffect` is a lint error in this repo.
- **Right-anchoring (`right-0`) is the SAME BUG, not the fix — and it is worse, because the trigger
  it hides behind is usually invisible at the width where it breaks.** Measured 2026-09-02: the
  notifications bell's panel opened at `left: -50 → right: 301` at 375px, and the messages menu's at
  `left: -174` at 640px. Both were already width-capped (`w-[min(380px,100vw-1.5rem)]`,
  `w-[min(760px,100vw-2rem)]`) and both still hung off the LEFT edge. Use `placeAnchoredPanel` in
  `src/lib/navigation/panel-position.ts` — it takes `align: "left" | "right"`, reuses the same clamp,
  and returns the offset from the anchor's LEFT edge so both alignments are one mechanism
  (`left-0` + `marginLeft`), never two. Note the messages trigger is `hidden sm:inline-flex`, so a
  375px probe finds a **display:none button with a degenerate rect** and under-reports the damage —
  measure at the narrowest width where the trigger is actually VISIBLE.
- **`backdrop-blur-xl` on the topbar SEALS every panel anchored inside it, so no z-index on the panel
  can lift it above the nav rows.** A backdrop-filter creates a stacking context, so the topbar's
  panels (`z-30` each) rank against each other and against nothing outside; the header then competed
  with the nav rows as ONE atomic box at "z-index 0, DOM order" and lost, being the earlier sibling.
  Measured 2026-09-02 at 375px: the `Organogram` nav link painted at `[42,93,110,111]`, **inside** the
  open notifications panel's `[12,64,363,620]`, legible on top of it. Fixed with `relative z-40` on
  the `<header>` itself — the box that actually competes. **This is invisible to a rect check:** the
  panel's own geometry is perfect, so only `document.elementFromPoint` over the panel's surface finds
  it. It is safe outward because AppShell's wrapper is `sticky top-0 z-30` and sticky *with* a
  z-index is itself a stacking context, so the 40 never escapes the chrome. The same trap is why
  `calculator-widget.tsx` portals to `document.body` — read its header comment before reaching for a
  portal, which is the heavier answer and detaches the panel from the row.
- **A native `<select>` is the one control this rule cannot fix, and you may NOT shrink it.** It
  never wraps its selected option. `app/globals.css` RULE 3 floors every form control inside
  `.admin-shell` / `.employee-portal-shell` at `max(16px, 1em)` below 768px, because iOS Safari
  zooms the page in on a smaller control and leaves it zoomed after blur — so a smaller class is
  inert (measured: `text-xs` and `text-sm` both compute to 16px at 375px) and would reintroduce that
  defect if it ever applied. On Reps List the Medical rep picker holds 322px of name in a 307px box
  and is left that way on purpose; the full name is printed in the section heading and on every rep
  card, so the clipped text is a duplicate and never the only copy. That is the pattern: when a
  control cannot fit, put the value somewhere outside it.
- **This does NOT relax the no-ellipsis rule.** Truncating with `…` still hides text and is still
  forbidden. **Wrapping is the permitted answer** — `break-words`, `align-top`, a taller row. Vertical
  space is free; horizontal space is not. The older standing rule "never let text wrap" was written
  against ellipsis-style truncation and he has now explicitly asked for stacked, wrapping cells, so
  where the two collide the golden rule governs and wrapping wins.
- The **admin shell's own sidebar** (`phoenix-admin-sidebar-scroll`) is a scrolling nav by design and
  is not what this rule is about. Scope any overflow audit to `main`, or every page reads as failing.

Related: [[portal-sidebar-label-width-budget]] · [[tailwind-merge-strips-custom-named-font-sizes]] ·
[[verify-a-mobile-layout-without-a-dev-server]] · [[a-minimized-window-makes-every-browser-test-lie]]
