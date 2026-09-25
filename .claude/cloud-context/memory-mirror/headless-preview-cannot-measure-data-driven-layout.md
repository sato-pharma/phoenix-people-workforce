---
name: headless-preview-cannot-measure-data-driven-layout
description: "The headless preview tab's useEffect never fires, so a data-driven layout bug cannot be measured there — an empty page reports zero overflow and looks like a pass."
metadata: 
  node_type: memory
  type: reference
  originSessionId: a2224779-e5db-46b9-962c-b3642028fdb4
  modified: 2026-08-02T02:20:53.869Z
---

**Verified 2026-08-02.** The in-app preview browser renders a page's server markup but its React
data effect often never runs: the server never receives the API call, tab counts stay 0, list items
stay 0, and `main` measures **width 0**. Confirmed repeatedly across fresh tabs, a fresh dev server,
`preview_start`, and `window.location.href` navigation with 28s settles.

🔴 **The trap:** for a layout bug caused by DATA (a long unbreakable string, a wide table row), an
unrendered page reports `documentScrollWidth === clientWidth` and `horizontalOverflowPx: 0` — which
reads exactly like a fix working. It is measuring nothing. **Always assert the content actually
rendered (`listItems > 0`, `mainWidth > 0`) BEFORE trusting any geometry number**, or you will
report a pass on an empty page.

Real case: the Expense Approvals mobile overflow (741px in a 375px viewport) is caused by a
95-character postal address inside the decision panel. With no records loaded there is no panel, no
address, and no overflow — so the measurement was worthless and the fix shipped unmeasured.

**What DOES work in this environment:** `javascript_tool` running
`fetch(url, {credentials:'include'})` returns real authenticated data (344 rows), so the server and
session are fine — it is the client effect flush that is broken. Server-rendered markup, route
existence (403 vs 404), and API behaviour are all verifiable; post-hydration geometry is not.

🔴 **The reusable UI trap this uncovered: an embedded Google Map overflows its container.**
`.gm-style` measured clientWidth **247 vs scrollWidth 486** — Google renders absolutely-positioned
internals wider than the box you hand it, and nothing clips them, so the whole page scrolls
sideways. **Always wrap a map in `overflow-hidden`.** Second cause in the same page: a
`grid ... md:grid-cols-2` whose items defaulted to `min-width: auto` (283 vs 436) — grid/flex items
need `[&>*]:min-w-0` or the column sizes to the longest line, not the viewport.

**Resolution (owner-confirmed on a real phone, 2026-08-02):** fixed by PR #1613 (page content,
741px → 375px) then PR #1618 (map clip + inner grid). Took TWO passes because the first fix was
built on a plausible hypothesis — a 95-character address — instead of a measurement. Asking the DOM
which elements overflow *themselves* (`overflowX === 'visible' && scrollWidth > clientWidth`) found
the real ones in one query. **Do that first, before theorising about CSS.**

Related: [[local-browser-verify-gotchas]] (same root cause — `document.hidden` true suppresses rAF),
[[prove-it-fails-verify-which-assertion-fired]] (same class of error: a red/green signal that did
not come from what you think).
