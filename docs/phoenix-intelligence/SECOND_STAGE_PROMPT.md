# Second stage — implement the KPI Reports polish

Paste this to the session (or the model) that will make the change. It is written to be followed as
is: the files, the rules that must survive, the order, and the checks that prove each finding.

---

You are implementing the premium polish of the Phoenix Workforce **KPI Reports** (the KPIs board), in
the repository `sato-pharma/phoenix-people-workforce`. The plan is
`docs/phoenix-intelligence/KPI_REPORTS_PREMIUM_POLISH_PLAN.md`. **Implement only the findings the
owner marked approved in that file.** Anything marked "his decision" that he has not answered stays
untouched. Do not redesign; polish.

## Read first

1. `AGENTS.md` and `CLAUDE.md` (the rules for every change).
2. `.claude/rules/crm-kpis.md` (the KPIs module's locked rules) and
   `.claude/rules/platform-design-tokens.md` (tokens, square edges, `TableRowDetail`).
3. `docs/phoenix-intelligence/KPI_REPORTS_COMPONENT_MAP.md` — which file draws what, and which files
   are shared beyond KPIs.
4. `docs/phoenix-intelligence/KPI_REPORTS_VISUAL_AUDIT.md` — the measured baseline you must improve
   and must not make worse.

## Rules that must still hold when you finish

- **Fits the screen at every width:** `w-full table-fixed` + `<colgroup>`; fit by merging columns,
  never by shrinking type; never `overflow-x-auto` over a `min-width`. Horizontal overflow stays 0 px
  at 1440, 768 and 390 px.
- **Square edges everywhere:** computed `border-radius` stays 0 on every element; never `rounded-full`.
- **No ellipsis:** long names and labels wrap.
- **Flat finish on this board** (owner, 22 Oct 2026; the board's own notes in `kpis-chrome.tsx`):
  no gradient, glow, drop shadow, gloss or badge-on-badge. Colour marks a status in one place.
- **AM and PM are never blended** into one rate; a missing figure prints its marker word ("No plan",
  "No calls", "Just started"), never 0.
- **Every figure stays the board's own arithmetic.** You change how numbers look, never how they are
  computed: no edit under `src/lib/crm/` unless a finding names it.
- **`text-phx-*` classes never pass through `cn()`** (tailwind-merge strips them silently); keep the
  plain template literals the KPIs files use.
- **`KpiSection` and `KpiTile` in `kpis-chrome.tsx` also draw Team Visits, Weekly Sheet and District
  Manager Plans** (`src/components/crm/regional/`). A change to either is checked on those screens too.
- **`src/components/ui/table-row-detail.tsx` and the shells are shared by the whole app.** Change them
  only where a finding says so and list every other screen that changes.
- The mobile app is out of scope. Production data is never touched. The Export XLSX file is out of
  scope unless a finding names it.

## How to work

1. Branch from `origin/main` in a new worktree (`node scripts/new-session.mjs kpi-polish`).
2. Take the approved findings in the plan's order (proven defects first). One finding at a time: make
   the change in the files the finding names, then its check.
3. Where a finding changes a class string, search the KPIs files for every copy of that string first
   (`src/components/crm/kpi*`, `kpis*`, `portal-kpi-report-page.tsx`) so the same element does not end
   up with two looks. **Grep `tests/` for the literal too, before replacing it** — a test that pins the
   old string is a rule, not an obstacle; stop and ask if one does.
4. Keep the tests green that pin this board. None of them may be loosened to pass:
   - `tests/kpi-coverage-premium.test.ts` and `tests/kpi-frequency-premium.test.ts` — no gradient,
     shadow, blur, rounding, `overflow-x-*`, `min-w-[`, truncate or line clamp; frequency also bans `cn(`;
   - `tests/kpis-trend.test.ts` — bans `cn(` in the trend view;
   - `tests/kpis-board-tables-fit.test.ts` — the columns fit at 619 px. Its `MEASURED` widths are
     measurements; **never edit them to go green**. A wider cell means the change is wrong;
   - `tests/form-design-system.test.ts` — `SIXTEEN_PX_KEEPS`: the 8 `text-base` filter controls stay
     16 px (iOS zooms a smaller field on focus). Finding O-01 never touches them;
   - `tests/square-edge-golden-rule.test.ts`, `tests/admin-shell-palette-scope.test.ts`;
   - `tests/table-structure-ratchet.test.ts`, `tests/table-row-detail-joined.test.ts`;
   - `tests/kpis-reports-split.test.ts`, `tests/kpis-new-hire.test.ts`, `tests/kpis-no-gps-feed.test.ts`,
     `tests/kpis-report-filters.test.ts`, and the rest of `tests/kpis-*.test.ts` and `tests/kpi-*.test.ts`.

   A test that pins a finding's new value is added with the `add-test` skill and proved by breaking
   the change once.
5. Type sizes (O-01): `text-sm` becomes `text-phx-base` with `leading-5` wherever the row's 20 px line
   box must hold, so row heights stay the same; `text-xs` becomes `text-phx-sm`, never `text-phx-xs`.
   Colour (V-01): a `text-slate-400` on the dark bar (`kpis-chrome.tsx:144`) stays; check each file's
   `bg-slate-` grounds before replacing.

## How to prove it (visual regression)

1. Before the first change, re-run the explorer against staging on the current `main` and keep the run
   id as the baseline:
   `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/phoenix-inspect/on-spare.ps1 explore --module kpi-reports`
2. After the change is on staging (a deploy of the branch to staging, never production), run it
   again with the same arguments.
3. Compare the two manifests shot by shot (`artifacts/phoenix-inspection/kpi-reports/<run>/manifest.json`,
   `measurements`). Every finding's acceptance line names the measurement and the value it must reach;
   in addition, **no shot may get worse** on: horizontal overflow, rounded elements, ellipsis cuts,
   distinct font sizes, non-token colours, small tap targets on mobile, low-contrast text.
4. Look at the masked screenshots of every state a finding touches, desktop and 390 px, before and
   after, side by side.
5. Report each finding as: done, with its measurement before and after and the two screenshot ids;
   or not done, with the reason.

## Delivery

One PR with every approved finding, its tests and the updated module memory line in
`.claude/rules/crm-kpis.md` if a rule changed. Commit, push and open the PR; the PR's own CI is the
verdict. **Do not merge** — ask the owner, by PR number.
