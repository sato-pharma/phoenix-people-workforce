---
name: feedback-admin-shell-responsive-golden-rule
description: "Standing design rule for ALL admin-shell restyle work (2026-07-24) — desktop shows full tables/dashboards, mobile NEVER horizontal-scrolls a table (convert rows to stacked cards instead), avoid childish/colorful icons, favor a Linear.app-style aesthetic."
metadata:
  type: feedback
  originSessionId: 7a4fd344-9e8e-4a7f-8f44-4e6f52c8d8df
  modified: 2026-07-24T02:48:43.471Z
---

Owner's golden rule for every future admin-shell page restyle (stated 2026-07-24, mid
[[admin-shell-design-rules]] restyle work on the Employees page):

1. **Desktop**: show big tables and dashboards in full — dense, wide, no artificial
   shrinking.
2. **Mobile**: a data table must **never** horizontal-scroll. Below the table
   breakpoint, convert each row into a stacked card (label/value pairs) instead of
   shrinking or scrolling the table sideways.
3. **Icons**: no "childish" icons — keep them small, monochrome/gray, functional only.
   Avoid colorful icon badges or decorative icon treatments (semantic status colors
   like a green "active" dot are fine; general UI icons should not be tinted per
   category).
4. **Aesthetic reference**: "I love lines and linears" — the owner wants a Linear.app
   look: hairline 1px borders (not shadows), monochrome/slate palette with the brand
   orange used sparingly as the one accent, dense compact rows, minimal/no rounded
   corners, small consistent type scale, fast subtle hover states (background tint,
   not scale/shadow pop effects).

**Why:** direct owner design mandate, given right after the Employees page's desktop
table+filters were approved as "raw and clean" — this is the standard to carry into
every subsequent page (tables, dashboards, KPI cards) during the ongoing admin-shell
restyle, not just this one page.

**How to apply:** when redesigning any admin-shell table/dashboard page: (a) build the
desktop table normally, (b) always also build a `sm`/`md`-and-below stacked-card
fallback for the same data instead of `overflow-x-auto`, (c) keep icons small/gray by
default, (d) default to hairline borders over shadows/gradients/rounded-heavy cards.
