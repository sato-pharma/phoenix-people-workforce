---
name: crm-mobile-cards-are-module-wide-and-ci-enforced
description: "Owner ruled 2026-08-21 that EVERY board under src/components/crm is desktop-table / mobile-cards. All 9 files are converted, and a whole-directory test makes a new unsplit board fail CI automatically."
metadata: 
  node_type: memory
  type: project
  originSessionId: 391647f9-8f7a-4e5f-a51e-3371c51627f0
  modified: 2026-08-21T08:16:47.800Z
---

**Owner ruling 2026-08-21:** the CRM module adopts the desktop-table / mobile-cards split
(AGENTS.md §4) **module-wide**, not per-board. Chosen over "portal-facing boards only" and over
"declare dense analytical boards a deliberate exception."

The deciding fact was that `DoctorCoverageBoard` is mounted at
`app/employee-portals/doctor-coverage/page.tsx` **as well as** the admin route — so a Medical Rep
opens it on a phone. This is not an admin-desk-only concern, which is how it reads if you only look
at `src/components/crm/`.

**All 9 files are converted** (PR #2264): `doctor-coverage-tables`, `rep-doctor-lists-tables`,
`doctor-coverage-board` (its call list is a div grid, not a `<table>`), `brick-coverage-tables`,
`crm-master-table`, `crm-recovered-chains-panel`, `crm-unmapped-identities-panel`,
`crm-region-mapping-panel`, `crm-customer-mapping-panel`. Every one goes through
`PortalResponsiveDataList` / `PortalDesktopTable` from `portal-primitives.tsx` — **never hand-roll a
second responsive primitive.**

**Why:** the audit that triggered this found **0 of 14** CRM files using the pattern against 44 of
529 elsewhere under `src/components/`. Every CRM table sat in a bare `overflow-x-auto` at every
width — a 700–1,100px table side-scrolling inside a 375px screen, with the mapping panels' own
*resolution control* in the last column, i.e. the first thing off the right edge.

**How to apply — the enforcement is automatic, and it already caught one.**
`tests/crm-mobile-table-cards.test.ts` scans the **whole** `src/components/crm/` directory rather
than an allowlist (deliberately unlike its portal sibling, which pins three named files), precisely
so a board added later cannot slip through. It earned that on the first try: Brick Coverage was
built on a parallel branch and merged as **#2261** after the split was written, arriving unsplit —
and the test went red naming `brick-coverage-tables.tsx` and the line the moment the branches met.
**Fix the board, never the test.**

**The guard only guards ONCE MERGED — and how to check across branches before then.** The reason
#2261 got through is not that the test was weak: it was that the test lived on an unmerged branch,
so `main` had no such test and #2261's CI was green against a `main` that predated it. Branch
protection has `strict: false` deliberately (AGENTS.md §2), so the two never ran together. To prove
a fix on branch A satisfies a directory-scanning test that still lives on branch B, without waiting
for either to merge: export B's whole `src/components/crm/` into a scratch directory, overlay the
files only A has, patch the test's `CRM_DIR` to point there, and run it. Done both ways on
2026-08-21 — it passed with the conversion and failed without it, naming
`brick-coverage-tables.tsx:120` and the 767px assertion. This is also how two parallel fixes of the
same file get spotted: #2264 and #2267 both converted this board, and #2267 was closed as the
duplicate once #2264 was confirmed to pass its own test with the board included.

Two shape rules the test also pins, both from real bugs: never nest a `<table>` inside
`<PortalDesktopTable>` (it already *is* the table — the double tag hydrates mismatched), and a
gate may sit on an ancestor rather than the element, so it looks 640 chars back.

**Keep the tone helper single-sourced.** Each board derives the card accent and the desktop bar
colour from one function (`toneOf`, `coverageAccent`, `adherenceAccent`), so the phone and the desk
can never disagree about where 50% and 80% sit. Annotate its return type — do **not** write
`as const` on the ternary, which is TS1355 and cost this PR a red CI run: see
[[parse-diagnostics-cannot-see-a-typecheck-error]].

Related: [[portal-grid-items-need-min-w-0-for-nowrap-cards]] ·
[[portal-sidebar-label-width-budget]] · [[crm-visits-join-to-bricks-both-maps-now-filled]]
