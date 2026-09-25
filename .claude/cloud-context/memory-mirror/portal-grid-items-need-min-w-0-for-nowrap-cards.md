---
name: portal-grid-items-need-min-w-0-for-nowrap-cards
description: "Any portal grid item holding nowrap text needs min-w-0, or its min-content width sizes the whole mobile column and pushes controls off screen — invisible on desktop."
metadata: 
  node_type: memory
  type: project
  originSessionId: da5b316c-c6c1-4593-abd2-1ff2cab200e2
  modified: 2026-08-19T18:04:03.207Z
---

The owner's rule that **text never wraps and is never ellipsised** means portal cards are full of
`whitespace-nowrap` lines inside `overflow-x-auto` boxes. That is correct — but it collides with CSS
grid in a way that only shows on a phone.

A grid item's **automatic minimum size is its min-content width**. `overflow-x-auto` several levels
deeper does NOT zero that — only the item itself being a scroll container, or carrying `min-w-0`,
does. So one long unwrappable line inside the card sizes the entire single-column mobile track, and
an ancestor `overflow-hidden` silently clips whatever no longer fits.

**Why it hides:** on desktop the track has room, so nothing looks wrong; `document.documentElement`
does not scroll horizontally either, because the overflow is clipped rather than scrolled — so the
usual "does the page scroll sideways" check reports PASS while controls sit off screen.

**How to apply:** when a portal card contains `whitespace-nowrap` text, put `min-w-0` on its grid
item. To find the culprit, measure min-content directly in the page —
`el.style.width = "min-content"; el.offsetWidth` — for each grid child, and compare against
`getComputedStyle(grid).gridTemplateColumns`. A track wider than the grid's own box is the signature.
Verify at a **mobile-first load** (390×844 from first paint), not by resizing a desktop render — a
resized page can keep stale geometry and gave a false PASS here.

**`text-ellipsis` on the clipped element is a DECOY — it proves nothing and does nothing.** When the
overflow lives at an ancestor, the paragraph is not overflowing its *own* box (`scrollWidth ==
clientWidth`), so `text-overflow` has nothing to act on and no ellipsis ever renders. The text is cut
mid-word instead, which reads like a copy bug rather than a layout bug. Two consequences: never take
a `text-ellipsis`/`truncate` class as evidence that truncation is handled, and never grep for those
classes to find clipped text — the clipping is at a `min-width: auto` grid item that carries no such
class. Measure `gridItem.getBoundingClientRect().right` against the nearest `overflow-hidden`
ancestor's right edge instead; that comparison is the actual test.

Live examples, both in `marketing-validation-workspace.tsx`:

- The "My Pharmacies" card sized the mobile column to 618px inside a 390px viewport once a pharmacy
  was picked, pushing the pharmacy tab row from 213–364px to 355–647px. Fixed by #2218.
- The **Pharmacy Validation section header** one level up had the same defect and shipped clipped for
  as long as the section existed (the earlier copy was the same length and clipped identically). Its
  grid item measured 335px in a 330px track — right edge 376.7px against the customer card's clipping
  edge at 361px, so 15.7px of the sentence was cut with no ellipsis. Fixed by #2220. Same shape:
  `min-w-0` on the grid item, sentence scrolls in `overflow-x-auto`.

Both are pinned at source by `tests/marketing-validation-pharmacy-card-min-width.test.ts`.

Related: [[dev-auth-is-header-only-browser-pane-cannot-use-it]] (how to get a real browser to measure
this in), [[portal-sidebar-label-width-budget]], [[portal-16px-input-floor-live-on-prod-2026-08-16]].
