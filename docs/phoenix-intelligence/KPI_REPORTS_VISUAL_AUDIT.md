# KPI Reports — visual audit

Scope: the KPIs board (admin `/admin/kpis`, HR `/hr/admin/kpis`, the portal's `/employee-portals/kpis`
and its Call Rate, Coverage and Frequency pages, and both `call-rate/[rep]` drill-downs). Component
locations: [KPI_REPORTS_COMPONENT_MAP.md](KPI_REPORTS_COMPONENT_MAP.md). Nothing here changes the UI.
The proposed changes are in [KPI_REPORTS_PREMIUM_POLISH_PLAN.md](KPI_REPORTS_PREMIUM_POLISH_PLAN.md), and each one waits for the owner's approval.

## 0. What this audit stands on

| Evidence | Status | Where |
| --- | --- | --- |
| **Source scan** of the 12 KPIs component files at `6df640b10` (same KPIs code as `950851277` and `fb27d6a8c`, see [PHOENIX_IMPLEMENTATION_VERIFICATION.md](PHOENIX_IMPLEMENTATION_VERIFICATION.md) §1) | **done** | sections 2–4; every count below is a `grep` over those files, repeatable |
| **Contrast arithmetic** (WCAG 2.x relative luminance) on the exact colours the classes compile to | **done** | finding V-01 |
| **Browser measurements** of the full 122-page run (overflow, computed radius, ellipsis, computed contrast, tap targets, console, network) | **not measured yet**: the spare laptop that runs the browser stopped answering at about 19:15 Cairo, 14 Nov | section 5 lists each measurement and the finding it would confirm or clear |
| **Smoke run** against staging (CEO summary desktop + Employee denied) | ran on the spare: CEO signed in and captured, Employee `denied-as-expected`, 0 privacy deletions, 2 writes stopped; **its files did not come back** (the copy dropped) | [PHOENIX_INTELLIGENCE_VALIDATION_REPORT.md](PHOENIX_INTELLIGENCE_VALIDATION_REPORT.md) |

A finding is **verified** only when its evidence is in this file and can be re-run. Anything that needs a
browser to see is listed as unmeasured, never guessed.

The KPI files the scan covered: `kpis-board-view.tsx`, `kpis-chrome.tsx`, `kpis-filter-bar.tsx`,
`kpis-period-picker.tsx`, `kpis-doctor-filter-bar.tsx`, `kpis-trend-view.tsx`, `kpi-reports-tables.tsx`,
`kpi-coverage-panels.tsx`, `kpi-coverage-rep-panels.tsx`, `kpi-frequency-panels.tsx`,
`kpi-frequency-rep-panels.tsx`, `portal-kpi-report-page.tsx` (all in `src/components/crm/`).

## 1. The rules every finding is checked against

- **Fits the screen**: no horizontal scroll at any width; `w-full table-fixed` + `<colgroup>`. AGENTS.md §4.
- **Square edges**: computed `border-radius` is 0 everywhere. AGENTS.md §4.
- **No ellipsis**: text wraps. AGENTS.md §4.
- **This board's flat finish**: no gradient, glow or drop shadow (owner, 22 Oct 2026, recorded in
  `kpis-chrome.tsx` and `kpis-board-view.tsx`), and nothing that looks machine-made (owner, 22 Oct 2026).
  The wider premium-polish rule of 8 Sep 2026 (`docs/agents-owner-rules.md`) brought depth back elsewhere.
  The board's own later ruling keeps it flat (decision D-01).
- **The board's figures**: AM and PM are never blended, and a missing figure prints its word ("No plan",
  "No calls", "Just started"), never 0 (`.claude/rules/crm-kpis.md`).
- **Tokens**: `src/styles/tokens.css`, the `text-phx-*` scale, and `--phx-track-label`.

## 2. Verified defects

### V-01 — Faint grey text fails the contrast minimum on white (severity: medium)

| | |
| --- | --- |
| **Evidence** | `text-slate-400` (#94a3b8) appears **60 times** in 10 of the 12 KPIs files: board view 29, chrome 5, filter bar 4, coverage panels 4, frequency panels 4, trend view 3, report tables 3, coverage rep panels 3, frequency rep panels 3, doctor filter bar 2. On white it measures **2.56:1**, on `slate-50` **2.45:1** and on `slate-100` **2.34:1**. WCAG AA needs **4.5:1** for text this size (11–13 px; `text-phx-xs` is 11 px, `text-phx-sm` 12 px, `text-phx-md` 13 px). **One** instance sits on a dark bar and passes: the section header description, `kpis-chrome.tsx:144`, on `bg-slate-900` at **6.96:1**. |
| **What it is on screen** | tile labels and hints (`kpis-chrome.tsx:217`, `:296`), the inactive rank mark (`:245`), column sub-headings (`HEAD_SUB`, `kpis-board-view.tsx:3205`, and its inline copies at `:1155`, `:1919`, `:2057`, `:2359`, `:2366`, `:3059`, `:3072`, `:3078`), the inactive tab labels and counts (`:835`, `:844`, and the copy at `:2908`, `:2917`), "of {target}" after the AM and PM rates (`:1307`, `:1317`), definition labels "Should visit", "Visited", "Gap", "Days", "Calls", "Short" and the measure labels (`:2244`, `:2740`–`:2757`, `:3167`–`:3180`, `:3419`), "Reported" and "Calls logged" (`:2256`, `:3008`), sort notes (`:2856`), and the "Overall KPI" eyebrow (`:675`). |
| **Files** | the 10 files above; nothing outside `src/components/crm/kpi*`. |
| **Proposed** | Use one darker grey for secondary text on light ground: `text-slate-500` (#64748b, **4.76:1** on white, **4.55:1** on `slate-50`), or the house token `--phx-ink-soft` (#6b7078, **4.98:1** / **4.76:1**). Which grey is decision D-02. Keep `kpis-chrome.tsx:144` as it is. |
| **Acceptance** | In the run's `measurements.lowContrast` (the computed colour against the computed ground, not the token, including the `bg-orange-50` filter chips), no text on a light ground is under 4.5:1 in any KPIs shot; the count goes from the baseline to 0. Nothing on the dark bars changes. The active tab keeps its `text-slate-900` / `text-orange-700` and its orange top rule, so selected and unselected stay apart. "No plan" and "Just started" (already `text-slate-500`, `kpis-chrome.tsx:88`) stay distinguishable from the labels beside them by their own weight and size, checked in the 390 px shots. *(The last two lines come from the CRM rules review, 14 Nov 2026.)* |
| **Risk** | Low. This changes only text colour, and no layout moves. The hierarchy flattens slightly, because labels get darker; the uppercase tracking and weight still mark them as labels. No test asserts `text-slate-400` (grep of `tests/*kpi*`). The colour is not a status: band colours live in `TONES`, `kpis-chrome.tsx:59–90`. **Reach:** `KpiTile`'s label (`kpis-chrome.tsx:217`) also draws the tiles on Team Visits, Weekly Sheet and District Manager Plans, which get the same darker grey. |
| **Verification** | Re-run `on-spare.ps1 explore --module kpi-reports` before and after. Compare `lowContrast` per shot, and look at the summary tiles, one table per tab and the tab strip, at desktop and 390 px. |
| **Status** | Verified from source and arithmetic. Which elements actually render on white or on `slate-50` is confirmed only by the run's computed backgrounds (section 5). |

## 3. Opportunities (no rule is broken; consistency and finish)

### O-01 — Two type scales on one board (severity: low)

- **Evidence:** 238 uses of the house scale (`text-phx-xs` 110, `text-phx-sm` 86, `text-phx-md` 41,
  `text-phx-lg` 1). Beside them are **62** uses of Tailwind's own scale in code, none in comments:
  - `text-sm` 45;
  - `text-base` 13;
  - `text-lg` 3;
  - `text-xs` 1.

  `tokens.css` explains why this shows. Tailwind's named sizes carry their own line-height and the
  `text-phx-*` sizes do not. So a 14 px `text-sm` (20 px line) and a 14 px `text-phx-base` (inherited line)
  set different line boxes.
- **Out of scope, deliberately:** **8** of the 13 `text-base` are form controls kept at 16 px so that iOS
  does not zoom the page when one is focused:
  - `kpis-filter-bar.tsx:241`, `:319`;
  - `kpis-period-picker.tsx:46`;
  - `kpis-doctor-filter-bar.tsx:160`, `:176`, `:189`, `:207`, `:216`.

  `tests/form-design-system.test.ts` (`SIXTEEN_PX_KEEPS`) pins them. The scale has no 16 px step, and a
  `text-phx-*` class passed through `cn()` is stripped. These lines are never touched. *(Found by the UI
  rules review, 14 Nov 2026.)*
- **In scope: 54:**
  - `text-sm` 45: board view 18, coverage panels 6, frequency panels 6, report tables 4, chrome 3,
    coverage rep panels 3, frequency rep panels 3, trend view 2;
  - the 5 `text-base` figure numbers: board view `:978`, chrome `:324`, trend view `:108`, coverage panels
    `:386`, frequency panels `:209`;
  - `text-lg` 3;
  - `text-xs` 1.
- **Proposed:** `text-sm` → `text-phx-base` (14 px), adding `leading-5` wherever the 20 px line box must
  hold (table rows, list items such as `kpis-board-view.tsx:1718`, `:1779`, `:2733`). `text-xs` →
  `text-phx-sm` (12 px). Never `text-phx-xs`, which is 11 px and would be a size change. The 16 px figure
  numbers and `text-lg` have no step; D-03 decides between leaving them and using the nearest step. Use
  plain template strings, never `cn()`: tailwind-merge strips custom `text-phx-*` sizes (module note
  `tailwind-merge-strips-custom-named-font-sizes`), and the coverage, frequency and trend tests ban
  `cn(` in those files.
- **Acceptance:**
  - row heights are **unchanged**, not merely equal to each other;
  - `distinctFontSizes` per shot does not rise;
  - no table gains overflow at 390 px;
  - no cell or head of `tests/kpis-board-tables-fit.test.ts` (measured at 619 px) widens;
  - zero text under 16 px on an `<input>` or `<select>` at 390 px.
- **Risk:** low to medium. Line boxes change wherever `leading-5` is left off, so the tables need the 390 px
  re-run.

### O-02 — Four letter-spacings for one kind of label (severity: low)

- **Evidence:** the uppercase micro-labels use `tracking-[0.12em]` 23 times, `tracking-[0.1em]` 17,
  `tracking-[0.14em]` 17 and `tracking-[0.16em]` 2. The house token is `--phx-track-label: 0.08em`
  (`tokens.css`).
- **Proposed:** one tracking for labels of one role: table and definition labels on one value, and
  section eyebrows on one. Whether to adopt the house 0.08em is decision D-04. The filled dark buttons
  (`kpis-board-view.tsx:3879`, `kpis-filter-bar.tsx:326`, `:362`, `kpis-doctor-filter-bar.tsx:42`) keep
  their `tracking-[0.12em]`.
- **Acceptance:**
  - at most two tracking values on labels in the KPIs files, counted by `grep -o 'tracking-\[[0-9.]*em\]'`;
  - labels still wrap at 390 px, with no ellipsis.
- **Risk:** low. D-04's recommendation only **narrows** spacing (0.1 → 0.08, 0.14 and 0.16 → 0.12), so no
  label gets longer.

### O-03 — The two large figures sit off the type scale (severity: none; recorded so it is not "fixed")

- **Evidence:** the hero figure is `text-[2.6rem]` (41.6 px, `kpis-board-view.tsx`) and the tile figure is
  `text-[1.7rem]` (27.2 px, `kpis-chrome.tsx`). `tokens.css` deliberately leaves sizes from 16 px up
  arbitrary ("a shared scale for a hero figure used once is not a scale"); the top step is 34 px.
- **Proposed:** no change, unless decision D-05 wants the tile on `--phx-fs-2xl` (26 px).

## 4. Verified clean (the source holds none)

| Check | Count in the 12 files | Note |
| --- | --- | --- |
| `rounded*` classes | **0** | square-edge rule held in source; computed radius needs the run |
| `shadow` / `bg-gradient-*` / `from-*` classes | **0** used | the 15 matches are `shadow-none` (4, which keeps the shell from adding depth) and comments that state the flat rule (11) |
| `truncate`, `text-ellipsis`, `line-clamp-*` | **0** | no-ellipsis rule held in source |
| `overflow-x-auto` / `min-w-[…px]` | **0** used | the 3 matches are comments warning against the pattern |
| Export XLSX | present, never touched | the explorer refuses it at three layers, see the component map §5 |

## 5. Measured by the browser run (pending)

Each line names the measurement the explorer records per shot (`lib/measure.mjs`) and what it settles.
The run covers 122 pages: CEO and DM at three widths across every state, and five more personas at
desktop and mobile.

| Measurement | What it would show | Finding |
| --- | --- | --- |
| `horizontalOverflowPx` at 1440, 768, 390 | the fits-the-screen rule on real data (long names, many columns) | new finding if any shot is over 0 |
| `roundedElements` (computed radius ≠ 0) | a radius from a shared primitive or the shell, which the source scan cannot see | new finding if any |
| `ellipsisCuts` | a cut from a shared primitive | new finding if any |
| `lowContrast` with computed backgrounds | confirms V-01's count and finds any light-on-light the classes hide | V-01 |
| `smallTapTargets` at 390 px (< 44 px) | tab strip, sort headers, row-detail toggles, filter toggles | new finding if any |
| `distinctFontSizes`, `nonTokenColours` | the size of O-01 on screen | O-01 |
| console errors, failed requests | a broken state | new finding if any |
| November (empty) period | that every empty figure prints its word, never 0 | rule check |
| loading and error mocks | the skeleton and the error answer | rule check |

**Until that run arrives, no claim in this file is made from a screenshot.** The screenshot index
([SCREENSHOT_INDEX.md](../../artifacts/phoenix-intelligence-delivery/SCREENSHOT_INDEX.md)) says which
shots exist.

## 6. Decisions for the owner

| ID | Question | Recommendation |
| --- | --- | --- |
| D-01 | The board keeps its flat finish (your 22 Oct ruling) rather than the depth of the 8 Sep premium-polish rule? | Keep flat; the plan adds no shadow, gradient or rounding |
| D-02 | The darker grey for secondary text: Tailwind `slate-500` or the house `--phx-ink-soft`? | `slate-500`: it is the family the board already uses, and 4.76:1 passes |
| D-03 | Move the 54 in-scope Tailwind-scale sizes onto the house scale (never the 8 form controls at 16 px)? And the 5 figure numbers at 16 px and the 3 `text-lg`: leave them, or use the nearest step? | Yes for the 46 `text-sm` / `text-xs`; leave the 8 figure sizes, which have no step |
| D-04 | One label tracking, and whether it is the house 0.08em? | Two values: 0.08em for table labels and 0.12em for eyebrows |
| D-05 | Leave the hero and tile figures at their own sizes? | Leave them |
