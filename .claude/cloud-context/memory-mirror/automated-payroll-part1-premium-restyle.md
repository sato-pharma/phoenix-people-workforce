---
name: automated-payroll-part1-premium-restyle
description: "The Automated Payroll wizard restyled onto the sitewide Phoenix admin-shell design system (AdminPageHero, adminPanelClassName, zebra/hairline grid). SHIPPED 2026-07-25 as bfa99d75b, in the same commit as the 4-tab Part 1 deductions split — the UNCOMMITTED line is stale. Useful as a worked example of what matching the admin shell actually means."
metadata:
  node_type: memory
  type: project
  originSessionId: a18d5dc4-6334-443d-9a12-4265945f4a9c
  modified: 2026-07-25T16:28:19.108Z
---

Same worktree/branch as [[automated-payroll-part1-other-deductions-4tabs]] (`_wt-automated-payroll-part1`, `codex/automated-payroll-part1` — a branch that already merged once via PR #1315, so diff carefully against `origin/main`). Owner asked to "premium polish this module... zebra tables instead of this dump design," then mid-session asked to move the step-nav sidebar to a horizontal strip above the table to free up its width.

**Root cause of "dump design":** `app/globals.css`'s PERMANENT ADMIN-SHELL RULE 2 forces every real `<table>`/`th`/`td` inside `.admin-shell` into a flat-black header + an orange-tinted hairline border on EVERY cell, rows and columns both (`!important`) — a dense per-cell "spreadsheet grid" look, not zebra rows. Fix was architectural (stop using `<table>`), not a class tweak, so as not to touch the shared global rule (would ripple across every other admin page).

**What changed:**
1. `src/components/automated-payroll/recommendation-step.tsx` — the grid is a CSS-grid div structure (`gridTemplate()` computes a per-step `grid-template-columns` string, applied via inline `style` to header + every row). Sidesteps `.admin-shell table` entirely. Zebra rows, hairline row dividers only, dark slate-900 header. Semantic tints (hold=rose, conflict=orange+left-accent, leaver=red) via a shared `rowTone()` helper, shared between the desktop grid and a new `hidden md:block`/`block md:hidden` mobile stacked-card fallback (old table had zero mobile treatment — an implicit h-scroll bug fixed as a side effect).
2. `src/components/automated-payroll/automated-payroll-wizard.tsx` — swapped bare shadcn `<Card>` for `adminPanelClassName`/`adminSoftPanelClassName` (same tokens as CEO Command Center — proven Phoenix identity, not invented). `AdminPageHero`'s `aside` now shows live `AdminInsightChip`s (phase, Part 1 X/8, Part 2 Y/6). **Second pass (same session):** the step-nav list was moved OUT of a fixed `lg:grid-cols-[260px_1fr]` sidebar entirely — `renderStepList` (vertical rows) became `renderStepPills` (horizontal flex-wrap pills), and the whole layout collapsed to one `flex flex-col` column: horizontal panel (step pills + Confirm button + Sheets/Publish toolbar, all in one card) sits ABOVE the recon stats and the grid, both now full-width. Page `max-w-6xl` → `max-w-[1600px]` to actually use the reclaimed space. Confirmed via `getBoundingClientRect`: recommendation grid rows are noticeably wider now with the sidebar gone.
3. `src/components/automated-payroll/finance-download-panel.tsx` — same panel-token treatment, light touch.
4. Primary CTAs get explicit `border-orange-600 bg-orange-600 ...` — shadcn's default Button variant resolves `--primary` to near-black (`oklch(0.205 0 0)`), NOT Phoenix orange. Easy trap: don't assume "primary variant = brand color" in this codebase.

**Squaring is automatic, don't fight it.** `.admin-shell [class*="rounded"] { border-radius:0 !important; }` already flattens every `rounded-*` class in scope — no need to add square-corner classes deliberately.

**Two real bugs found via actual browser verification (not just code review) — both fixed and reverified:**

1. **Text-overlap in the grid.** Long employee names (e.g. "Ahmed Sharaf Eldeen Ahmed Gad Elkareem") spilled out of the Employee column and rendered ON TOP of the Hire Date column text — owner spotted this from their own real screenshot mid-session (`C:\Users\satoh\Downloads\Screenshot 2026-07-25 114324.jpg`, read via the Read tool). Root cause: `min-w-0` on a grid-item flex wrapper correctly lets the TRACK shrink to its `minmax()` floor, but does NOT clip overflowing text — that needs `overflow-hidden` too, which was missing. Fixed by adding `overflow-hidden` (with an inner `whitespace-nowrap` span) to every text-bearing grid cell in both the desktop grid and the mobile cards — the memory-endorsed "silent clip, no ellipsis" fallback from [[no-text-truncation-or-wrapping]]. **Verified precisely, not just eyeballed:** `getBoundingClientRect` showed the name span's `scrollWidth` (303px, what the text wants) vs `clientWidth` (200px, the clipped box) — genuine clipping confirmed — and a full sweep of all 25 grid rows on the live page returned zero cell-boundary overlaps.
2. **Stale-HMR crash after a mid-session `.next` cache clear.** Cleared `.next/dev/types` to fix an unrelated corrupted-generated-file typecheck error while the dev server kept running; this desynced Fast Refresh so the browser kept running OLD compiled JS that still called the pre-rename `renderStepList` (which no longer existed after the sidebar→horizontal-strip rename) → `ReferenceError`, silently swallowed by Next's error boundary and indistinguishable from the "stuck Suspense" symptom (page stuck on the loading skeleton) until `read_console_messages` surfaced the actual stack trace. **Lesson: if a page won't hydrate after editing a component that was recently renamed/restructured, check the console for a real JS error before assuming it's the known headless-preview flakiness** — a full `rm -rf .next` + fresh dev-server restart resolved it (confirmed via a subsequent clean load with zero console errors).

**Verification this time was real, not just DOM-structure-checked:** got actual screenshots (desktop hero/step-nav/grid, mobile step-nav, mobile stacked cards with a real leaver row showing "Settled in Resignations: 2903"), triggered the double-deduction conflict banner live via a `javascript_tool`-dispatched input event (client-side only — confirmed via network log that no PUT/save request ever fired, so nothing touched production) and saw the banner correctly name the employee and both amounts. Also spotted a **pre-existing, unrelated bug**: a React "duplicate key" console error for `rail-/organogram` in the shared sidebar nav (Organogram appears twice in the rail) — not caused by this work, not fixed, worth a separate task.

**Environment note reinforcing [[local-browser-verify-gotchas]]:** repeated rapid `navigate`+immediate-check cycles kept re-racing hydration and produced false "stuck" readings for over an hour of this session, across multiple root causes (racing navigations, cold-compile time after a cache clear, the genuine stuck-Suspense quirk, AND a real stale-HMR crash) — each needed a different fix (wait longer, wait for compile, retry navigation, hard-restart the server). Don't assume it's always the same cause; check the console error log first, it's the fastest way to tell them apart.

**Before merging:** visual verification is now done (screenshots + precise layout checks), typecheck/lint/429-tests all green. **NOW COMMITTED** (as of 2026-07-25) on `codex/automated-payroll-part1` @ `cc48bd7e`, still unmerged to `main` — so `main`'s `recommendation-step.tsx` still shows the old `<table>`. A code search of the primary checkout will therefore "prove" the div-grid doesn't exist; it does, on that branch.

**This is the canonical zebra-grid recipe for any new admin data table.** Reused by the Deductions module god-mode plan. The three details that matter: (1) `gridTemplate()` returns one `grid-template-columns` string applied via inline `style` to BOTH header and every row so they can't drift; (2) every text cell needs `overflow-hidden` + an inner `whitespace-nowrap` span — `min-w-0` alone shrinks the track but does NOT clip text, which is what caused the real overlap bug above; (3) semantic tone classes must take precedence over the zebra expression, hence `!tone && (index % 2 ? …)`.

## 2026-09-04 — shipped the same day

The description said **UNCOMMITTED**. It went in as `bfa99d75b` (2026-07-25) —
*feat(automated-payroll): split Part 1 deductions into 4 tabs, premium restyle* — so the restyle
and the 4-tab split are one commit.

This is worth keeping as a concrete example behind the standing rule *before building any new UI,
inspect the sibling pages in that module and match their exact design identity*. The component
names here are what that rule looks like in practice.
