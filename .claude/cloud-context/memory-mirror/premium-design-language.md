---
name: premium-design-language
description: "The \"Report It\" premium design recipe the user loves — reuse it when asked to premium-polish any module"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 06f7989f-6910-4a16-973a-673ad1fd295c
---

The user loves the Report It module's premium look and asks for it on other modules ("the same premium polish"). The recipe (square corners + slate-900 + orange #F97316):

- **Fields:** `h-10/11 w-full border border-slate-300 bg-white px-3 text-sm focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-500/20` (selects add `cursor-pointer`).
- **Micro label:** `mb-1.5 block text-[11px] font-black uppercase tracking-wide text-slate-500` (required → `text-rose-600 *`).
- **Buttons:** dark `border border-slate-900 bg-slate-900 text-white hover:bg-slate-800`; primary orange `border-orange-600 bg-orange-600 hover:bg-orange-700`; ghost `border-slate-300 bg-white text-slate-700 hover:bg-slate-100`; all `px-4/5 py-2 text-sm font-bold`.
- **Dark section/block header:** `bg-slate-900 px-4 py-3` with an orange accent bar `<span className="h-4 w-1 bg-orange-500"/>` + `text-sm font-black uppercase tracking-wide text-white` title. (Lighter variant: `bg-slate-50 border-b border-slate-200` + same orange bar + `text-slate-700`.)
- **Hero (full):** `bg-slate-900` banner, phoenix mark via `systemAssets.adminRailMark` (next/image), orange kicker `text-[11px] font-black uppercase tracking-[0.25em] text-orange-400`, optional progress bar `bg-white/10` track + `bg-orange-500` fill. **REUSABLE: `<PremiumHero kicker title subtitle subtitleClassName badge />` at `src/components/ui/premium-hero.tsx`** — use it for any premium module page header. **`EmployeePortalPageShell`'s DEFAULT banner IS now PremiumHero (shipped PR #114, live)** — every employee-portal page using the shell gets the Report It hero automatically (badge→kicker, title, description→subtitle). Pages can still override via the `hero` prop (e.g. Plans uses a custom "Planning Workflow" kicker). Admin pages: drop in `<PremiumHero/>` directly (Plans admin did, replacing adminHero).
- **Cards:** `border border-slate-200 bg-white shadow-sm`, square. KPI cards can add a top accent bar.
- **Square everything except `rounded-full`** (pills/dots). Admin pages already square via globals.css; the EMPLOYEE PORTAL does NOT, so portal views need explicit square classes.

**Shared admin hero already exists:** `@/components/admin/admin-design-tokens` (`adminHeroSurfaceClassName` = black-gradient hero + orange glow). Admin page headers use it; don't rebuild per-page.

**Sweep trick for squaring a file:** the suffixed radius tokens (`rounded-lg`/`-xl`/`-2xl`/`-full`) all have a hyphen, and bare `rounded` is always followed by a space → `replace_all "rounded " → ""` squares bare rounded without touching `rounded-full`; do the hyphenated ones (except `-full`) separately.

Done so far: Report It (PRs #99–#104, live). Weekly/Monthly Plans workspace = [[report-it-module-build]]-style polish in PR #107 (shared plans-workspace.tsx; both /admin/weekly-plans + /employee-portals/plans).

**Workflow reality:** can't screenshot worktrees (Next 16 Turbopack rejects node_modules junction) and portal auth pages 500 on preview (no env) → verify premium visual changes on PROD after merge.
