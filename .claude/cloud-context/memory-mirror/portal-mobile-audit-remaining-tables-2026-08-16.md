---
name: portal-mobile-audit-remaining-tables-2026-08-16
description: "Mobile audit of all 110 employee-portal pages, 2026-08-16 — the 3 raw tables (all fixed in #2175) and the five false-positive classes that waste a re-audit."
metadata: 
  node_type: memory
  type: project
  originSessionId: 3059dd29-f9dd-415b-8ce4-95b1f9be0b4f
  modified: 2026-08-16T11:38:56.325Z
---

Audit of **all 110 employee-portal pages** (344 reachable component files), 2026-08-16,
after [[portal-16px-input-floor-live-on-prod-2026-08-16]] fixed the systemic defect.

**Clean:** 0 clipped `min-w-[Npx]`, 0 fixed `w-[Npx]` over 380px. No portal page parks data
off the right edge unreachable. The layout is broadly mobile-safe; the font-size was the bug.

**Genuinely not mobile-safe: 3 raw tables, ALL FIXED** in PR #2175 (`b2462ba5`) — cards under
768px, full table above. Pinned by `tests/employee-portal-mobile-table-cards.test.ts`.

| File | What a phone lost |
| --- | --- |
| `src/components/sales/targets-workspace.tsx` | the customer NAME — a `<table>` nested in a `<table>`, nothing scrolls it sideways in a drill-down |
| `src/components/recruitment/bulk-cv-extraction-panel.tsx` | the file name AND the Review button — wrapper was `overflow-hidden`, so CLIPPED not scrolled |
| `src/components/recruitment/intake-health-view.tsx` | the HEADERS — 4 count columns whose header row scrolls off the top |

**`double-visit-analytics-workspace.tsx:402` was a FALSE POSITIVE** — it lives in
`ExpandableMrRow`, rendered only inside `<PortalDesktopTable minWidth="920px">`, with
`MrScoreCard` as its mobile counterpart. Already unreachable on a phone. Do not "fix" it.

Same PR fixed a real hydration bug: `early-birds-rep-table.tsx` nested a `<table>` inside
`<PortalDesktopTable>`, which already IS the table — the parser foster-parents the inner one
out while React keeps it nested, so server and client markup disagreed.

The fix pattern is `PortalDesktopTable` + a `md:hidden` card block, not `overflow-x-auto`
(the owner's rule is desktop tables, mobile CARDS).

**Five false-positive classes — do not re-report these:**

0. **A two-column label/value table is not a data grid.** `FieldTable` in
   `approvals-hub/direct-order-detail-primitives.tsx` (the owner's own 2026-08-08 request) and
   the `?` keyboard-shortcuts panel in `action-center/action-center-hub.tsx` both scan as raw
   tables and both are already correct on a phone.


1. **`PortalDesktopTable`** (`src/components/employee-portal/portal-primitives`) is already
   hidden under 768px by `[data-portal-desktop-table] { display: none !important }` in
   `enterprise-shell.tsx`. Most portal tables use it. A scanner that only looks for
   `hidden md:block` reports every one of them as broken.
2. **`grid-cols-7`** is a calendar week. Every portal calendar hits a "3+ columns on a phone" rule.
3. **`enterprise-shell.tsx:129`** — the hero's `grid-cols-3` Surface/Mode/Status strip, reached
   by 89 pages. Static short labels ("Portal", "Employee", "Ready") at 9–12px. Fine at 375px.
4. **`src/emails/**`** — HTML email templates. `<table>` IS the layout language of email and they
   never render in a viewport. They are reachable from a page only because it imports the mailer.

A 3+ column grid is only a defect when the cells hold **dynamic** values (names, money, dates) —
those are `whitespace-nowrap` by the owner's rule, so they overlap instead of wrapping. Static
labels are fine. See the same finding proven in `direct-orders-approval-window-mobile.test.ts`.
