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
| **Browser measurements** (overflow, computed radius, ellipsis, computed contrast, tap targets, console, network) | **measured on 52 of the 122 planned pages**: the CEO's admin board at 1440, 768 and 390 px, run `20261114-205500-kpi` against staging, 20:59–21:47 Cairo, 14 Nov. **The other 70 are not measured** (section 5.4): the District Manager's portal pages, the five other personas and the loading and error mocks were never reached | section 5 |
| **Eye check** of masked shots | 5 viewed: 007 and 009 (Coverage, desktop and phone), 021 (Weekly, phone), 043 (November, desktop), 053 (advanced filters, phone). Names and figures are masked; the board's own words are kept | findings UX-01, U-01, U-02 |
| **Smoke run** against staging (CEO summary desktop + Employee denied), 19:12 | CEO signed in and captured, Employee `denied-as-expected`, 0 privacy deletions, 2 writes stopped; its files never came back from the spare, and the full run above replaces it | [PHOENIX_INTELLIGENCE_VALIDATION_REPORT.md](PHOENIX_INTELLIGENCE_VALIDATION_REPORT.md) |

A finding is **verified** only when its evidence is in this file and can be re-run. Anything that needs a
browser to see is listed as unmeasured, never guessed. The findings are kept in four groups: **verified
defects** (a measured number breaks a rule or WCAG AA), **usability issues** (seen on a shot, no rule
number), **recommendations** (better, but nothing is broken), and **uncertain findings** (need a source
read or the owner's word).

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
| **Evidence** | `text-slate-400` appears **60 times** in 10 of the 12 KPIs files: board view 29, chrome 5, filter bar 4, coverage panels 4, frequency panels 4, trend view 3, report tables 3, coverage rep panels 3, frequency rep panels 3, doctor filter bar 2. This repo's Tailwind 4 compiles it to **rgb(144, 161, 185)**, read from the browser's computed colour. On white it measures **2.63:1**, on `slate-50` **2.51:1**, on `slate-100` **2.40:1** and on `orange-50` **2.48:1**. WCAG AA needs **4.5:1** for text this size (11–14 px). **One** instance sits on a dark bar and passes: the section header description, `kpis-chrome.tsx:144`, on `bg-slate-900` at **6.78:1**. *(The first draft quoted 2.56 / 2.45 / 2.34 / 6.96: those are Tailwind 3's `#94a3b8`. The run measured the real colour.)* **The run confirms it:** 2.63:1 at 13–14 px is the most common low-contrast reading in all 52 shots. Its biggest source is the tab strip's inactive labels and figures (`a > span`, 13 and 14 px, between 13 and 35 shots per tab position). |
| **What it is on screen** | tile labels and hints (`kpis-chrome.tsx:217`, `:296`), the inactive rank mark (`:245`), column sub-headings (`HEAD_SUB`, `kpis-board-view.tsx:3205`, and its inline copies at `:1155`, `:1919`, `:2057`, `:2359`, `:2366`, `:3059`, `:3072`, `:3078`), the inactive tab labels and counts (`:835`, `:844`, and the copy at `:2908`, `:2917`), "of {target}" after the AM and PM rates (`:1307`, `:1317`), definition labels "Should visit", "Visited", "Gap", "Days", "Calls", "Short" and the measure labels (`:2244`, `:2740`–`:2757`, `:3167`–`:3180`, `:3419`), "Reported" and "Calls logged" (`:2256`, `:3008`), sort notes (`:2856`), and the "Overall KPI" eyebrow (`:675`). |
| **Files** | the 10 files above; nothing outside `src/components/crm/kpi*`. |
| **Proposed** | Use one darker grey for secondary text on light ground. Measured on the four light grounds the board uses (white / `slate-50` / `slate-100` / `orange-50`): **`text-phx-ink-soft`** (`--phx-ink-soft`, #6b7078) **4.98 / 4.76 / 4.55 / 4.69**, passes on all four; `text-slate-600` **7.58 / 7.25 / 6.92 / 7.14**, passes with room; `text-slate-500` **4.76 / 4.55 / 4.35 / 4.49**, **fails on `slate-100` and `orange-50`**, so it is no longer recommended. Which grey is decision D-02. Keep `kpis-chrome.tsx:144` as it is. |
| **Acceptance** | In the run's `measurements.lowContrast` (the computed colour against the computed ground, not the token, including the `bg-orange-50` filter chips), no text on a light ground is under 4.5:1 in any KPIs shot; the count goes from the baseline to 0. Nothing on the dark bars changes. The active tab keeps its `text-slate-900` / `text-orange-700` and its orange top rule, so selected and unselected stay apart. "No plan" and "Just started" (already `text-slate-500`, `kpis-chrome.tsx:88`) stay distinguishable from the labels beside them by their own weight and size, checked in the 390 px shots. *(The last two lines come from the CRM rules review, 14 Nov 2026.)* |
| **Risk** | Low. This changes only text colour, and no layout moves. The hierarchy flattens slightly, because labels get darker; the uppercase tracking and weight still mark them as labels. No test asserts `text-slate-400` (grep of `tests/*kpi*`). The colour is not a status: band colours live in `TONES`, `kpis-chrome.tsx:59–90`. **Reach:** `KpiTile`'s label (`kpis-chrome.tsx:217`) also draws the tiles on Team Visits, Weekly Sheet and District Manager Plans, which get the same darker grey. |
| **Verification** | Re-run the explorer (`explore.mjs --module kpi-reports`, memory-guarded on this laptop, or `on-spare.ps1 explore --module kpi-reports` when the spare is up) before and after. Compare `lowContrastText` per shot against run `20261114-205500-kpi`, and look at the summary tiles, one table per tab and the tab strip, at desktop and 390 px. |
| **Status** | **Verified** from source, arithmetic and the browser run (computed colour against computed ground, section 5). Baseline per page: desktop 13–150, tablet 13–130, phone 20–654 low-contrast text nodes. Some of that count is not V-01: section 5.2 lists the shell's share (V-02). The phone counts above 500 are the same labels repeated on every rep card; this is inferred from the paths, not counted card by card. **Note on `--phx-ink-soft`:** the dark theme redefines it as #8a8781 (`tokens.css:351`). On a dark ground it then becomes lighter, which is the right direction. |

### V-02 — Shared-shell text under 4.5:1 on the KPIs pages (severity: medium; outside the KPIs files)

These are measured on every KPIs shot, but they belong to the admin shell, so every admin page has them.

| Element (computed path) | Size | Ratio | Shots |
| --- | --- | --- | --- |
| sidebar group captions (`nav > div:nth-of-type(8) > div > p`, six per page; on shot 043 they read Order Desk, Direct Order Pharmacies, Direct Order Setup, CRM Boards) | 10 px | **4.41:1** | 18 (every desktop shot) |
| a label inside the header's second button (`header > div > button:nth-of-type(2) > span`) | 14 px | **3.95:1** | 33 (every desktop and tablet shot) |
| a status mark inside a button (`button > span[role="status"]`) on the two rep drill-downs | 9 px | **2.8:1** | 2 (048, 051) |

- **Files:** the shell, not `src/components/crm/kpi*`. Which shell file draws each one is not mapped yet.
  The paths above find them in the browser.
- **Proposed:** none in this plan. A shell change reaches every admin page, so whether it joins this pass
  is decision D-06.

## 2a. Usability issues (seen on a shot; no measured rule)

### UX-01 — The search hint is cut off on a phone (severity: low)

- **Evidence:** shot 053 (CEO, advanced filters open, 390 px). The search box shows "Rep, line, region,
  area or mar". The source text is "Rep, line, region, area or manager" (`kpis-filter-bar.tsx:321`).
  `ellipsisCuts` cannot see this, because a placeholder is not a text node. It came from looking at the shot.
- **Proposed:** at phone width, give a shorter hint ("Rep, area or manager"), or move the full hint into a line
  under the Search label, where it can wrap.
- **Acceptance:** the whole hint is visible at 390 px; the input stays 16 px (the `SIXTEEN_PX_KEEPS` floor).
- **Risk:** low; one string or one line in one file.

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
- **The run agrees:** 41.6 px appeared on 45 shots and 27.2 px on 45.

## 3a. Recommendations from the run (nothing is broken)

### R-01 — Phone tap targets under 44 px

44 px is the AAA and platform guidance; the WCAG 2.2 AA minimum is 24 px. Every target in this list
meets 24 px except one, the drill-down link at 16 px.

| Target (computed size) | Where | Phone shots |
| --- | --- | --- |
| 5 header icon buttons, 36×36 | shell header | 19 of 19 |
| Month and Period selects, 332×40 | board header | 16 |
| Export XLSX link, 117×36 | board header (`div:nth-of-type(2) > div:nth-of-type(1) > div:nth-of-type(2) > a`; its size matches the button on shot 053) | 17 |
| Advanced filters toggle, 193×38; a view button, 217×38 | filter bar; Weekly view buttons | 2 and 1 |
| an input, 324×32, and a link, 120×16 | the call-rate rep drill-down (shot 051) | 1 each |

- **Proposed:** `min-h-11` (44 px) on the board's own controls; the shell's 36 px icon buttons are D-06.
- **Risk:** low to medium. A taller select or link moves the rows under it, so check the 390 px shots.

### R-02 — The board's page loads slowly on staging

The slowest `/admin/kpis` documents took about 6–13 s (for example: summary about 13 s twice; tabs 6–13 s).
Staging is not production, and staging's 126,330 visits stop in August. **This is not a finding about
production.** It is recorded so that the second stage measures before and after on the
same environment.

### R-03 — The status colours are Tailwind palette colours, not house tokens

The 15 non-token text colours the run found are exact Tailwind 4 palette colours (the largest difference is
0 in each channel): orange 600/700, amber 700/900, rose 700/800, emerald 700/800 and sky 700/800. They
are the board's band tones (`TONES`, `kpis-chrome.tsx:59–90`). They are deliberate, not defects. Moving
them onto `--phx` tokens would be a palette decision, not polish, so this plan leaves them.

## 3b. Uncertain findings (need a source read or the owner's word)

### U-01 — The empty month reads 0% and "Behind"

Shot 043 (CEO, November, desktop): Coverage **0%**, Frequency **0%**, AM and PM call rate **0.00**, Overall
**0%**, team standing "Behind · under 50%", and every Standing Out card reads "Nobody in view can be ranked
on this measure yet." Staging holds November plans but no visit since October ("Most of the planned list
has not been reached at all yet"), so these may be true zeros: planned, not visited. The KPIs rules say a
figure with nothing behind it prints its word, never 0 (`.claude/rules/crm-kpis.md`). Whether a month with
a plan and no call is "nothing behind it" is for the CRM rules review, not this audit. **No change is
proposed.**

### U-02 — The tab strip's AM · PM and Pharmacies figures disappear on the Weekly tab

Same month (August), phone: on Summary (shot 053) the strip reads a percentage for AM · PM and for
Pharmacies. On Weekly (shot 021) it reads "— AM · — PM" and "Not applicable". The source prints "Not
applicable" when nobody in view carries a pharmacy list (`kpis-board-view.tsx:746–748`). So the Weekly
tab may build its strip from a different set of reps or period. Read the source before calling it a
defect.

### A capture artefact, not a finding

On the full-page desktop shots, the black sidebar stops at the first screen's height (900 px), and the page
continues beside empty ground. That is how a full-page capture draws a fixed sidebar. A person scrolling the
page never sees it.

## 4. Verified clean (the source holds none)

| Check | Count in the 12 files | Note |
| --- | --- | --- |
| `rounded*` classes | **0** | square-edge rule held in source; computed radius needs the run |
| `shadow` / `bg-gradient-*` / `from-*` classes | **0** used | the 15 matches are `shadow-none` (4, which keeps the shell from adding depth) and comments that state the flat rule (11) |
| `truncate`, `text-ellipsis`, `line-clamp-*` | **0** | no-ellipsis rule held in source |
| `overflow-x-auto` / `min-w-[…px]` | **0** used | the 3 matches are comments warning against the pattern |
| Export XLSX | present, never touched | the explorer refuses it at three layers, see the component map §5 |

## 5. Measured by the browser run

Run `20261114-205500-kpi`, against staging, persona CEO (admin board), on this laptop with a memory guard,
20:59–21:47 Cairo, 14 Nov 2026. Staging served `c33a435b1` when the run finished. Between `6df640b10` and
`c33a435b1`, `git diff` over the KPIs, CRM, styles, navigation, portal and both KPIs route folders is empty,
so the board's code was the same throughout. Every number below is in the run's `manifest.json` and was
recorded by `lib/measure.mjs` per shot.

### 5.1 Clean on every measured page (52 of 52)

| Measurement | Desktop (18) | Tablet (15) | Phone (19) | Rule |
| --- | --- | --- | --- | --- |
| `horizontalOverflowPx` | 0 | 0 | 0 | fits the screen: **held** |
| `roundedElements` (computed radius ≠ 0) | 0 | 0 | 0 | square edges: **held** |
| `ellipsisCuts` | 0 | 0 | 0 | no ellipsis: **held** (UX-01 is a placeholder, which this cannot see) |
| console errors | 0 | 0 | 0 | — |
| failed requests | 0 | 0 | 0 | — |
| keyboard focus (Tab from the top) | a button, visible ring, in view | — | a link, visible ring, in view | — |
| internal scrollers | the sidebar list (vertical) and, with Advanced filters open, three option lists in 176 px boxes (vertical) | sidebar only | the same as desktop | no horizontal scroller anywhere |

**Writes the fence stopped:** 54 session-pulse POSTs (`/api/auth/pulse`) and 1 `/api/activity/track`, all
from the page's own scripts. Staging's `audit_logs` for the inspection logins since 18:00 Cairo holds
only sign-ins: `INSPECT-CEO` 13 (19:13 to 21:44: the smoke run, then one per pass), `TEST-INSPECT-EMP` 1
(the 19:13 smoke run). Read at about 22:00.

### 5.2 What the run found

| Measurement | Per page | Finding |
| --- | --- | --- |
| `lowContrastText` (computed colour on computed ground, under 4.5:1) | desktop 13–150, tablet 13–130, phone 20–654 | V-01 (2.63:1, the KPIs files) and V-02 (4.41, 3.95 and 2.8:1, the shell) |
| `contrastUnmeasured` (no solid ground behind the text) | 4–5 on every page | counted, never guessed; not a finding |
| `smallTapTargets` under 44 px | phone 9–157 | R-01 |
| `distinctFontSizes` | 8–12 per page; 15 over the run: 9, 10, 11, 12, 12.48, 13, 14, 15, 16, 18, 19.2, 20, 22.4, 27.2 and 41.6 px | O-01, O-03 |
| `nonTokenTextColours` | 7–14 per page | R-03 |
| slowest documents | about 6–13 s | R-02 |

The per-shot table is in the delivery (`SCREENSHOT_INDEX.md`).

### 5.3 The states the run covered

Summary; the six other tabs; Call Rate AM and PM; Weekly by quarter; week 1; sorted by coverage;
filtered to "behind"; a search with no match; November (the empty month); the coverage rep drill-down
(phone); the call-rate rep page (phone); Advanced filters open; a row detail open (desktop); keyboard focus.

### 5.4 Not measured: 70 of the 122 pages, and why

| Pages | Why |
| --- | --- |
| 3 CEO drill-downs: coverage rep at desktop and tablet, call-rate rep at desktop | **error** "locator.click: Timeout 30000ms exceeded". The explorer clicked the first rep link, which at those widths is the phone-card copy and hidden. Fixed in `34c116286` (it follows the first **visible** link; the self-check fixture now carries a hidden copy first and passes 34 of 34). **Not re-run.** |
| 4 CEO pages: call-rate rep (tablet), row detail (phone), the error mock (desktop, phone) | not reached |
| 53 District Manager pages (the portal's KPIs, Call Rate, Coverage and Frequency pages, at three widths) | not reached |
| 10 pages: SFE Manager, HR Resourcing, NSM, rep and Employee (denied path), landing page at desktop and phone each | not reached |

**Why they were not reached:** this laptop's memory. You said not to depend on the spare laptop, so the run
moved here under a memory guard. An outer guard stops a pass whenever free memory falls under its floor.
With the floor at 1,900 MB, passes were stopped at 1,895, 1,862 and 1,721 MB free. The last was under the
1,800 MB freeze line, so the floor was raised to 2,150 MB. The next two passes were stopped at 2,147 and 2,134 MB, and the loop ended at
21:47 after two passes in a row with no new page. **Not one District Manager page was measured, so the
portal side of this audit is open,** and the desktop-tables / phone-cards rule (R10) is checked on the
admin board only.

## 6. Decisions for the owner

| ID | Question | Recommendation |
| --- | --- | --- |
| D-01 | The board keeps its flat finish (your 22 Oct ruling) rather than the depth of the 8 Sep premium-polish rule? | Keep flat; the plan adds no shadow, gradient or rounding |
| D-02 | The darker grey for secondary text: the house `text-phx-ink-soft`, `slate-600`, or `slate-500`? | `text-phx-ink-soft`: the house token, and it passes on all four light grounds (4.55–4.98:1). `slate-500` fails on `slate-100` (4.35) and `orange-50` (4.49), so it is no longer the recommendation |
| D-03 | Move the 54 in-scope Tailwind-scale sizes onto the house scale (never the 8 form controls at 16 px)? And the 5 figure numbers at 16 px and the 3 `text-lg`: leave them, or use the nearest step? | Yes for the 46 `text-sm` / `text-xs`; leave the 8 figure sizes, which have no step |
| D-04 | One label tracking, and whether it is the house 0.08em? | Two values: 0.08em for table labels and 0.12em for eyebrows |
| D-05 | Leave the hero and tile figures at their own sizes? | Leave them |
| D-06 | The shell's own items (V-02 contrast, and the 36 px header buttons in R-01): fix them in this pass, which reaches every admin page, or in a separate shell pass? | A separate shell pass, so this one stays inside the KPIs files |
