# KPI Reports — premium polish plan

**Nothing in this plan has been implemented.** Each change waits for the owner's approval in the last
column of section 2. The implementing session follows [SECOND_STAGE_PROMPT.md](SECOND_STAGE_PROMPT.md)
and implements only rows marked approved.

Evidence for every row is in [KPI_REPORTS_VISUAL_AUDIT.md](KPI_REPORTS_VISUAL_AUDIT.md) (finding ids V-, O-,
D-). The files each row touches are mapped in [KPI_REPORTS_COMPONENT_MAP.md](KPI_REPORTS_COMPONENT_MAP.md).

## 1. What "premium" means on this board

The board was flattened on purpose (owner, 22 Oct 2026), and the 9 Nov Coverage and Frequency pass
kept it flat. Premium here means **precision, not ornament**:
- secondary text a manager can read in daylight on a phone;
- one type scale;
- one label voice;
- every edge square;
- nothing that overflows or is cut short;
- colour that marks a status in one place.

The plan adds **no** shadow, gradient, glow, gloss, rounding or badge-on-badge. Any row that would is out
of scope (decision D-01).

Unchanged by every row:
- the figures, which are the board's own arithmetic (no edit under `src/lib/crm/`);
- AM and PM, which are never blended;
- the marker words ("No plan", "No calls", "Just started"), which are never replaced by 0;
- the Export XLSX file;
- the shared shells and `TableRowDetail` (no row needs them).

## 2. Decision table

| Pri | ID | Change | Files | Blast radius | Risk | Acceptance (measured by the explorer) | Owner approval |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P0 | — | **None found in source.** A P0 is a broken golden rule: horizontal overflow, a computed radius, an ellipsis cut, a fake 0, or AM and PM blended. The source holds none (audit §4). The full browser run decides, and any it finds becomes a P0 row here. | — | — | — | run: `horizontalOverflowPx` 0, `roundedElements` 0, `ellipsisCuts` 0 on all 122 pages | **PENDING** (the run) |
| P1 | V-01 | Secondary text on light ground from `text-slate-400` (2.56:1) to `text-slate-500` (4.76:1), or `--phx-ink-soft` (4.98:1) per D-02, in all 59 light-ground uses. The section header description on the dark bar (`kpis-chrome.tsx:144`) stays. Before each file, grep its `bg-slate-` grounds. | the 10 KPIs files in audit V-01 | KPIs, plus Team Visits, Weekly Sheet and District Manager Plans through `KpiTile`'s label (`kpis-chrome.tsx:217`); `app/globals.css:1047`'s own `text-slate-400` is not in scope | low: colour only, no layout change | `lowContrast` (computed colour on computed ground, the orange-50 chips included) goes from the baseline to 0 in every KPIs shot; dark-bar text unchanged; the active tab keeps `text-slate-900` / `text-orange-700` and its orange rule; "No plan" and "Just started" stay distinct from the labels beside them at 390 px | **PENDING** |
| P2 | O-01 | Put the **54 in-scope** Tailwind-scale sizes on the house scale: `text-sm`→`text-phx-base` (+ `leading-5` where a row's 20 px line box must hold), `text-xs`→`text-phx-sm` (never `text-phx-xs`); the 5 figure numbers at 16 px and the 3 `text-lg` per D-03. **Never touch** the 8 `text-base` form controls (`kpis-filter-bar.tsx:241`, `:319`; `kpis-period-picker.tsx:46`; `kpis-doctor-filter-bar.tsx:160`, `:176`, `:189`, `:207`, `:216`). Those are the 16 px floor that stops iOS zooming on focus, pinned by `form-design-system.test.ts` `SIXTEEN_PX_KEEPS`. Use plain template strings, never `cn()`. | `kpis-board-view.tsx`, `kpis-chrome.tsx`, coverage and frequency panels, trend view, report tables | KPIs, plus the three regional screens wherever the change is in `KpiSection` or `KpiTile` | low to medium: line boxes change where `leading-5` is left off | row heights **unchanged**; `distinctFontSizes` per shot does not rise; `horizontalOverflowPx` 0 at 390 px; no cell or head of `kpis-board-tables-fit.test.ts` widens (never edit its `MEASURED` to go green); no `<input>` or `<select>` text under 16 px at 390 px | **PENDING** |
| P3 | O-02 | One letter-spacing per label role: two values in place of four (0.1, 0.12, 0.14, 0.16em), per D-04. The filled dark buttons keep 0.12em. | the KPIs files using `tracking-[…]` | KPIs, plus the three regional screens for `KpiSection`'s title (`:143`) and `KpiTile`'s label (`:217`) | low: D-04 only narrows spacing, so no label gets longer | at most two label tracking values, counted with `grep -o 'tracking-\[[0-9.]*em\]'`; no new wrap into a cut at 390 px | **PENDING** |
| — | O-03 | **No change** to the hero (41.6 px) and tile (27.2 px) figures. `tokens.css` deliberately leaves sizes of 16 px and up off the scale. | — | — | — | — | **PENDING** (D-05) |

## 3. Owner decisions the rows depend on

| ID | Question | Recommendation | Owner approval |
| --- | --- | --- | --- |
| D-01 | Keep this board flat (22 Oct) rather than the 8 Sep depth rule? | Keep flat | **PENDING** |
| D-02 | Secondary grey: `slate-500` or the house `--phx-ink-soft`? | `slate-500` | **PENDING** |
| D-03 | Move the 46 `text-sm` / `text-xs` onto the house scale in the same pass, and leave the 8 sizes that have no step (5 figure numbers at 16 px, 3 `text-lg`)? The 8 form controls at 16 px are never moved. | Yes | **PENDING** |
| D-04 | Label tracking: 0.08em for table labels and 0.12em for eyebrows? | Yes | **PENDING** |
| D-05 | Leave the two large figures at their own sizes? | Yes | **PENDING** |

## 4. Tests that must stay green (none may be loosened to pass)

| Test | What it pins here |
| --- | --- |
| `tests/kpi-coverage-premium.test.ts` (`runKpiCoveragePremiumTests`) | no gradient, `shadow-[`, `drop-shadow`, `backdrop-blur`, `rounded`, `overflow-x-*`, `min-w-[`, `truncate`, `text-ellipsis` or `line-clamp-` in the coverage panels |
| `tests/kpi-frequency-premium.test.ts` (`runKpiFrequencyPremiumTests`) | the same bans for frequency, and **no `cn(`** in the panels |
| `tests/kpis-trend.test.ts` | **no `cn(`** in the trend view |
| `tests/kpis-board-tables-fit.test.ts` | each table's columns fit at 619 px (`MEASURED`) |
| `tests/form-design-system.test.ts` | the one form design, and `SIXTEEN_PX_KEEPS`: the filter controls keep `text-base` |
| `tests/square-edge-golden-rule.test.ts`, `tests/admin-shell-palette-scope.test.ts` | square edges |
| `tests/table-structure-ratchet.test.ts`, `tests/table-row-detail-joined.test.ts` | table structure and the shared row detail |
| `tests/kpis-reports-split.test.ts`, `tests/kpis-new-hire.test.ts`, `tests/kpis-no-gps-feed.test.ts`, `tests/kpis-report-filters.test.ts` | the board's behaviour around the changed files |

No test asserts `text-slate-400`, `tracking-[` or the Tailwind sizes in the KPIs files (grep of
`tests/*kpi*`, 14 Nov 2026). Grep again before replacing, in case one was added since.

*(Sections 2–4 were checked by the UI and CRM rules reviewers on 14 Nov 2026. Their corrections are in:
the 16 px form-control exclusion, `leading-5`, the computed-ground contrast, the active-tab and
"No plan" checks, and this test list.)*

## 5. Order of work once approved

1. Baseline run on current `main`: `on-spare.ps1 explore --module kpi-reports`. Keep the run id.
2. P0 rows, if the run adds any.
3. P1 (V-01). This is one search-and-replace per file, but each use is checked against its ground: a use
   on a dark bar stays.
4. P2, then P3, each followed by the 390 px look.
5. Look at Team Visits, Weekly Sheet and District Manager Plans at desktop and 390 px if a row
   changed `KpiSection` or `KpiTile`; the explorer does not walk those screens yet.
6. After-run on staging with the same arguments. Compare per shot (the second-stage prompt, "How to
   prove it"). No shot may get worse on any measurement.
7. One PR with every approved row and its tests.

## 6. Screenshots per row

The before shots for each row come from the full run: every state at desktop and 390 px for the CEO
and DM personas. The run did not complete on 14 Nov (the spare laptop went dark; see the audit §0), so
no shot ids are listed yet. [SCREENSHOT_INDEX.md](../../artifacts/phoenix-intelligence-delivery/SCREENSHOT_INDEX.md)
says which exist.
