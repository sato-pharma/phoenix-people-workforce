---
name: four-module-guards-a-new-phoenix-crm-screen-must-pass
description: "A new screen under src/components/phoenix-crm must satisfy four guards no sibling documents and none of which a typecheck or lint sees — the phone cards come BEFORE the desktop table (the detector only looks forward from </CrmCardsOnPhone>), a spread colgroup forces the header row to be MAPPED from the same array, the words account/accounts/doctor/doctors are banned in any screen string even on an /admin page a rep cannot open, and a new sidebar label needs its measured width from scripts/measure-sidebar-labels.ts. Read the four before writing the screen; found one at a time they cost four red runs."
metadata:
  node_type: memory
  type: project
  originSessionId: 369b9c60-2032-48eb-8853-ad2148939e4f
  modified: 2026-10-03T22:51:30.620Z
---

Four separate guards in the unit suite police a new Phoenix CRM screen. **None of them is visible
to the typecheck or to lint, none is documented on the sibling you copy from, and each one fails on
a DIFFERENT run** — so found one at a time they cost four full iterations. Measured 2026-10-04
building the touch-trail reader (#5281): four reds, in this order.

1. **`tests/sidebar-label-width.test.ts`** — a new nav card's label needs a measured pixel width in
   its own shell. Run `node --experimental-strip-types --experimental-specifier-resolution=node
   --experimental-loader ./tests/alias-loader.mjs scripts/measure-sidebar-labels.ts` (never
   `pnpm run ui:measure-sidebar-labels` from a worktree — see [[never-pnpm-inside-a-worktree]]). It
   appends one line to `tests/fixtures/sidebar-label-widths.json`; "Touch Trail" was 62px.

2. **`tests/phoenix-crm-fits-the-screen.test.ts`** — if the `columns` literal contains a spread,
   the `<thead>` region must contain `.map(`. One array feeds both or they drift. But note the
   trade: **a spread literal is also invisible to that test's ≤100% width-sum check**, so assert
   the sum in your own test. The two valid shapes are *inline width literals + hand-written `<th>`s
   with matching counts*, or *spread widths + a mapped header row*; mixing them fails.

3. **`tests/phoenix-crm-am-pm-words.test.ts`** — `account`, `accounts`, `doctor`, `doctors` are
   banned in any screen string in `src/lib/phoenix-crm` or `src/components/phoenix-crm`, because
   they were the retired names for AM and PM list types (owner, 2026-09-23). The sweep is a blunt
   regex over comment-stripped source and does **not** care that your page is under `/admin` where
   no rep can reach it. A pill reading "Test account" had to become **"Test persona"** — which is
   the repo's own word (`isTestPersona`) and needed no exception.

4. **`tests/phoenix-crm-unplanned-visit.test.ts`** — the phone cards must come **before** the
   desktop table. The detector finds each `<CrmCardsOnPhone>` and demands a `*Table` within 400
   *collapsed* characters **after** its closing tag; it never looks backwards. Table-first is
   visually identical (`md:hidden` vs `hidden md:block`) and fails anyway. Every sibling —
   `validated-place-list.tsx`, `validation-review-queue.tsx`, `customer-list-board.tsx` — is
   cards-first.

**The lesson that generalises past these four:** a local subset of tests chosen by name cannot find
them, because none of their names mentions the thing it polices. `node scripts/remote-check.mjs
test` runs all 2,175 files on the box in ~160s and costs the laptop nothing — run it once before
the first push instead of discovering the guards one red run at a time. See
[[the-preview-boxs-next-build-ooms-after-compiling-successfully]] for the one stage of that script
which currently cannot finish there.
