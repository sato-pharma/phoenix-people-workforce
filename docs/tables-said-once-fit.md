# Tables say every fact once, and fit the screen

The owner's order, 2026-10-28 Cairo, after a district manager's day table printed "no plan" four times on one
row and drew its detail line as a second row: *"DEEP AUDIT ALL TABLES AND ANY THING THAT MAY BE SOURCE OF CHAOS AND
PREMIUM POLISH AND TIDY IT AND GODMODE THE SYSTEM OVERALL"*. His answer on the extra lines under rows, 2026-10-29
~01:30 Cairo: **"Fold in, joined panel"**. #6640 fixed that one table; this branch carries the same fix to every
data table in the web app, in ONE pull request.

This file is the account of the change and the brief every builder works from. Builders are cloud sessions with
no other context — everything a builder needs is here, in `CLAUDE.md`, in `AGENTS.md` and in the module memory
(`.claude/rules/<module>.md`) of the files it opens.

## The rules every table now keeps

1. **Every fact once.** A fact a row shows in one cell is never printed again in that row — not in another cell,
   a chip, a note, a tooltip line or its opened panel. A fact that is the same on every row (the month, the person
   whose day it is, "no plan was sent") is said ONCE above the table, never on each row. The template is #6640:
   `src/lib/phoenix-crm/manager-visit-table.ts` (`planActualRowWords`, `planActualSaysNoPlan`) decides the words a
   row prints in a pure `src/lib` function, and `everyFactSaidOnce` in
   `tests/phoenix-crm-manager-visit-details.test.ts` proves no fact appears twice.
2. **No second row.**
   - A line shown under EVERY row (buttons, a note, a warning, a recommendation) moves INTO that row's own cells —
     an Actions column, the first cell, the status cell.
   - A panel the row opens on a click stays, but is the row's own: write it with `TableRowDetail` from
     `@/components/ui/table-row-detail` (it renders `<tr data-row-detail><td colSpan>`), and put
     `{...rowDetailToggleProps(id, open)}` on the opening row or its toggle button. No background class on the panel.
     The panel drops every line the row already shows (date, person, customer, status, amount).
   - A hand-written `<tr><td colSpan={…}>` under a data row is never added again.
   - `app/globals.css` RULE 2 draws a 1px orange border on every cell with `!important`; `tr[data-row-detail] > td`
     is its ONE exception (top edge `hidden`), and the row and its panel tint together on hover. Nothing else may
     weaken a cell border.
3. **Fits the screen, desktop and phone — never a sideways scroll** (`AGENTS.md` §4, the fits-the-screen golden rule).
   - No `overflow-x-auto` wrapper around a data table; no `min-w-[…]`, `min-w-max` or inline `minWidth`/`width` on a
     table or its wrapper; no `border-separate` (it doubles the grid lines).
   - `w-full table-fixed` with a `<colgroup>` whose percentage widths add up to 100. Fit by MERGING related facts
     into one cell (name over job title; date over time; amount over its status), never by shrinking type.
   - In a cell, text wraps: `break-words`, with `min-w-0` on a flex parent. Never `whitespace-nowrap`, `truncate`,
     `line-clamp-*` or `text-ellipsis` in a cell (the no-ellipsis rule).
   - Every table has a phone layout below `md`: cards that carry EVERY column's fact. Pick the pieces by area —
     payroll, admin, attendance, approvals, coaching, probation, vacation: `AdminTableShell` +
     `PortalDesktopTable` (`@/components/employee-portal/portal-primitives`) + `PortalResponsiveDataList`; sales,
     CRM, CRM integrity, double visit, customers: `CrmTable` + `CrmCardsOnPhone` + `CrmCard`/`CrmFacts`
     (`@/components/phoenix-crm/ui`); employee portal, direct orders, marketing, outstation, recruitment, offers:
     `PortalDesktopTable` + `PortalResponsiveDataList`. A table inside a grid cell switches on its own width
     (`@container`). Match the sibling pages' look; never a one-off.
   - Every `PortalDesktopTable` caller passes `cols` (a `<colgroup>`); the prop becomes required in the last commit.
     Never pass the dead `minWidth` prop.
4. **Names, never codes or ids.**
   - Never `String(x).replace(/_/g, " ")` on a value people read. A domain that owns a label function uses it
     (`employmentStatusLabel`, `describeDirectOrderStatus`, `vacationTypeLabel`, `validationStatusLabel`, the plan
     labels, the marketing and recruitment labels); everything else uses `humanizeCode` from
     `@/lib/format/code-label`, or `codeOrWords` when the value may already be words. A request status shown outside
     its module uses `requestStatusLabel` from `@/lib/approvals-hub/request-status-label`.
   - Never an HR id on screen beside or instead of a name: "Name (B-10)" becomes the name. Namesakes are told apart by
     job title or line, never the id. An "Employee ID" column becomes name plus job title.
   - "{product} ({code})" shows the product name only.
   - "N/A", "No HR ID" and similar filler: a "—" in a table cell, left out of a card.
5. **The look is locked — do not fight it.** Square corners (no `rounded*`), the black centred header and the orange
   grid (RULE 2) stay exactly as they are; never add a shadow, gradient or glow; zebra stripes are left alone.

## Left alone — do not touch

- The four protected files in `CLAUDE.md`, and everything under `mobile/` (frozen).
- The three tables that scroll by the owner's decision, each with its reason: the monthly closing matrix
  (`MatrixScroller`), the CRM Master report (`data-wide-report`), and the Payroll Copilot 27-column sheet in
  `src/components/payroll/copilot/payroll-copilot-workbench.tsx` (rebuilt that way on his July screenshots; only
  its per-row recommendation line folds into the status cell).
- Tables that are not data tables: `email-body-editor`, the interview calendar's month picker, the offer joining
  form (`offers/joining-form-page`), the hiring-pack papers, the spotlight sheet, `src/emails/**`, and every
  payroll or closing export / workbook builder.
- Nothing under `src/lib/sales/**` changes a figure — this is presentation only. Every sales and target number
  still comes from the closing engine.

## Who builds what — disjoint files, one branch

Branch: `codex/tables-said-once-fit`. The foundation commit (this file, `table-row-detail.tsx`, `code-label.ts`,
`request-status-label.ts`, the RULE 2 exception and hover in `app/globals.css`) is already on it.

| Builder | Owns (edit nothing else) |
| --- | --- |
| **F — foundation** | `src/lib/**` (P5 below), every NEW test file, `tests/run-tests.ts`, `scripts/check-contracts-gates.mjs`, `tests/admin-shell-palette-scope.test.ts`, the ratchet baselines, `.claude/rules/**`, `docs/**` |
| **A — admin and people operations** | `src/components/{admin,payroll,automated-payroll,approvals-hub,attendance,action-center,coaching,probation,vacation,devices,hr-ops-reports,report-it,hiring-documents,employees,employee-360,early-birds,field-workforce-compliance,field-absence,field-activity,hr-calendar,milestones,retention,organogram,new-hire-mailbox,mailbox-offboarding,company-activity-report,contracts,reports,cv,resignations}/**`, `app/(admin)/**` |
| **S — sales** | `src/components/{sales,direct-orders,business-review,sales-marketing-intelligence,production-planning,market-awareness}/**` |
| **C — CRM and customers** | `src/components/{crm,phoenix-crm,crm-integrity,double-visit-analytics,double-visit-report,territory-management,customer-360,customer-identity,customer-pharmacy-mapping,pharmacy-search,visual-aids}/**` |
| **P — employee portal** | `src/components/{employee-portal,marketing-requests,outstation,recruitment,offers}/**`, `app/employee-portals/**` |

An existing test file that pins a component belongs to the builder who owns that component. Only F edits
`tests/run-tests.ts`; a builder that needs a new test registered says so in its final message.

### What each builder does in its own files

Work through every table-drawing file you own (`grep -rlE "<table|<CrmTable|<PortalDesktopTable|<RgTable|<AdminTableShell"`)
and apply rules 1–4. Known findings, worst first:

**A — admin and people operations**
- Second rows shown on every row: `devices/headwind-fleet.tsx` (~893: the buttons under every tablet → an Actions column).
- Click-to-open panels → `TableRowDetail`: `attendance/weekly-attendance-review.tsx` (~784), `admin/deductions-workspace.tsx`
  (~1983), and every other `<tr>…<td colSpan>` under a data row in your folders.
- `attendance/employee-day-report.tsx` (403–470): 11 columns at `min-w-[1280px]` → 6: Date, Outcome (+ its reason
  only when the reason adds something the outcome does not say), Punches, Worked (+ late / short minutes, once),
  Deduction, Approve. F changes the reason text at its source (`src/lib/attendance/digest-reconcile.ts`,
  `flexible-hours.ts`) to return null when it only restates the outcome — render it only when present.
- `attendance/weekly-attendance-review.tsx` (421/447/461): the "Ticked: … / Not ticked: …" sentence once, not on every
  line; each line shows "0.25 day" OR "Deduct quarter day", never both.
- Approvals details: `approvals-hub/vacation-request-detail.tsx` (52–127), `excuse-request-detail.tsx` (45–71),
  `direct-order-request-detail.tsx`: drop rows repeating the header's type / date / duration and the second request
  code; "Employee: Name (B-10)" → the name. `approvals-hub/history-list.tsx` (169–178) renders the titles F builds.
- Raw codes: `stuck-approvals-panel.tsx` (~360), `payroll/payroll-history.tsx` (~56), `action-center/action-center-hub.tsx`
  (197–407), `approval-recommendation-badge.tsx` (~21); the "Employee ID" first column in
  `attendance/monthly-attendance-summary.tsx`, `attendance-analytics-dashboard.tsx`, `attendance-exceptions-manager.tsx`.
- Sideways scroll / no phone layout (worst first): the admin Telegram (`telegram-admin-control-center.tsx`,
  `telegram-template-manager.tsx`), `system-cleanup-center.tsx`, `synthetic-journeys-dashboard.tsx`, `audit-log-viewer.tsx`,
  `email-engagement-view.tsx`, `access-control-manager.tsx`, the payroll screens (8 of 9 scroll; the Copilot sheet
  stays), `app/(admin)/**` pages with their own tables, the salary report, caps manager, `m-payroll`.
- `resignations/resignations-ui.tsx` `RgTable` (~288): `table-fixed` + a required colgroup, no scroll, no
  `whitespace-nowrap`; `RgPerson` shows name and job title, never the HR id. Its caller is `resignations-workspace.tsx`.
- "N/A" in expense cells if any are in your folders.
- Pinning tests to update with the shape: `tests/deductions-bulk-decide.test.ts` (~69),
  `tests/deductions-candidates-table-fits-the-screen.test.ts` (~168).

**S — sales**
- Click-to-open panels → `TableRowDetail`: `sales/vs-target/vs-target-dashboard.tsx`, `sales/targets-workspace.tsx`,
  and every other one in your folders.
- "{productName} ({productCode})" in direct orders → the name.
- Sideways scroll / no phone layout: 16 sales files, 5 direct-orders files; the sales queue, the direct-order
  detail, Marketing ROI. The closing matrix keeps `MatrixScroller`.
- Ellipsis in cells: the sales dashboard, the import preview, the ROI filter.
- Pinning tests: `tests/sales-target-tables-fit-the-screen.test.ts` (~292, ~311), `tests/weekly-sales-fits-the-screen.test.ts`.
- Read `.claude/rules/` for every sales module you open; never change what a number IS, only how it is laid out.

**C — CRM and customers**
- Second rows shown on every row: `phoenix-crm/shared-place-list.tsx` (556, 578: the venue and its seated customers go
  in the first cell, one row per venue).
- Click-to-open panels → `TableRowDetail`: `crm/kpis-board-view.tsx`, `phoenix-crm/visit-report/visit-report-table.tsx`
  (211–216: the panel drops date, visitor and customer), `phoenix-crm/report-list.tsx` (~250: the shared `renderOpen` —
  one edit fixes every caller), `crm-integrity/integrity-board-view.tsx`, and every other one. `crm/crm-master-table.tsx`
  keeps its wide-report scroll, but its opened panel becomes `TableRowDetail` too.
- `phoenix-crm/daily-plan-report.tsx`: an empty place shows nothing, never "No place yet".
- Sideways scroll: CRM integrity, the customer directory and double-visit screens.
- Pinning tests: `tests/phoenix-crm-manager-visit-details.test.ts` (~376), `tests/kpis-board-tables-fit.test.ts`.

**P — employee portal**
- Second rows shown on every row: `employee-portal/plans-workspace.tsx` (3056, 3096: notes and warnings into the date
  cell that already spans the day), `offers/offer-job-titles.tsx` (~337: the letter text under its select).
- `employee-portal/private-calendar.tsx`: TimelineItem (2084–2170) and AgendaView (1742–1790) render the lines F trims at
  the source; show the "read-only activity context" note and the source label ONCE per source in the legend, never on
  every entry. (Its status map already moved to `request-status-label.ts`.)
- Click-to-open panels → `TableRowDetail`: `outstation/expense-report.tsx`, `recruitment/workspace/candidate-table.tsx`,
  and every other one.
- "N/A" → "—" / left out: `outstation/outstation-requests-admin.tsx` (×4), `outstation/eligibility-result-card.tsx` (~50),
  and the expense dashboards in your folders (`personal-expense-workload-dashboard.tsx` ×9,
  `nsm-team-expenses-dashboard-impl.tsx` ×4, `medical-rep-expenses.tsx` ×3 — wherever they live).
- Raw codes: `employee-portal-dashboard.tsx` (~765), the marketing and recruitment screens.
- Sideways scroll / no phone layout: marketing (4), direct-order screens under the portal, and the rest in your folders.
- Pinning test: `tests/expense-dashboard-trips-table-fits-the-screen.test.ts` (~119).

**F — foundation (`src/lib`, guards, ratchets)**
- Private calendar, at the source: `src/lib/private-calendar/field-visits.ts` (257–312: kind in title AND a "Kind:"
  line; counts in time AND a "Visits:" line; the same note and source label on every entry), `plan-items.ts`
  (149–254: "Approved" four ways; "Half day: AM" under a time of "AM"), `logic.ts` (450–578: `recommendedAction` as
  description AND "Action:"; "(pending)" in title, chip, source label and note; an excuse's 2 hours said four ways),
  `manager-own-visit-items.ts` (66–100), `phoenix-work-evidence-items.ts` (98–129). Each detail line that restates the
  title, time, status or chip goes.
- Attendance: `src/lib/attendance/digest-reconcile.ts` (156–175) returns no reason when it only restates the outcome
  ("Approved leave." under "Approved leave"; "Official holiday." under "Holiday"; "On time and full hours." under
  "Complete"); `flexible-hours.ts` (214–289) stops repeating the minutes the Late and Short cells show.
- Approvals history titles: a new pure `src/lib/approvals-hub/history-title.ts`, called from `service.ts`
  (~1080, ~1101, ~1142, ~2420): `vacationTypeLabel`, a Cairo date (never ISO), no module prefix (the tab says it).
- New guards, each registered in `tests/run-tests.ts` AND in `scripts/check-contracts-gates.mjs` (the
  `tests/check-contracts.test.ts` gate checks the two agree):
  - `tests/table-row-detail-joined.test.ts` — the CSS exception is exactly its two selectors (`.admin-shell` and
    `.employee-portal-shell` `tr[data-row-detail] > td`); no other rule weakens a cell border; a `<td colSpan` in a
    second `<tr>` written outside `TableRowDetail` is counted as a ratchet (baseline = today's count, lowered at the end).
  - `tests/table-structure-ratchet.test.ts` — per table file: missing `table-fixed`, missing colgroup / `cols`, a
    `min-w-[` or inline width, no phone layout; allowlist with reasons (closing matrix, CRM Master, Payroll Copilot
    sheet, `email-body-editor`, the interview month picker, `offers/joining-form-page`).
  - `tests/no-raw-code-on-screen-ratchet.test.ts` — `replace(/_/g` on a shown value, `"N/A"`, `"No HR ID"`,
    `hrId ||` in `.tsx`, comments stripped with `tests/support/comment-strip.ts`.
  - Said-once tests: `tests/private-calendar-said-once.test.ts`, `tests/attendance-day-reason-said-once.test.ts`,
    `tests/approvals-history-titles.test.ts`; and `tests/code-label.test.ts` for `humanizeCode` / `codeOrWords` /
    `requestStatusLabel`.
  - `tests/admin-shell-palette-scope.test.ts` §7 also pins the td border, the centred black header,
    `border-collapse`, and that no selector but the joined-panel exception weakens a cell border.
- Record the rule in `.claude/rules/platform-design-tokens.md` `## Rules` (one bullet, first `**bold**` span is the
  claim), then run `node scripts/module-memory/build.mjs`.

## How every builder works

1. `git fetch origin && git checkout codex/tables-said-once-fit` (never `main`). `pnpm install --frozen-lockfile`.
2. Edit only the files your row owns. Commit in small pieces, conventional messages
   (`fix(tables): …`), each ending with the `Co-Authored-By` line the session gives.
3. Before every push: `node scripts/check-contracts.mjs`, then `git pull --rebase origin codex/tables-said-once-fit`,
   then `git push origin HEAD:codex/tables-said-once-fit`. Never force-push. If the push to that branch is refused,
   push to your own branch and NAME it in your final message.
4. Run the tests for what you touched. One test file:
   `node --experimental-strip-types --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs -e "import('./tests/<file>.test.ts').then((m) => m.<exportedRunFunction>())"`.
   A typecheck is fine in the cloud (`pnpm run typecheck`; prefix `PHX_TYPECHECK_OK=1` if a hook refuses it).
5. Never open a pull request, never merge, never touch production data, never send an email. The control session
   opens the one PR when every builder has pushed.
6. A ratchet (`fits-the-screen-ratchet`, `no-ellipsis-truncation-ratchet`, `square-edge-*`) may go DOWN under your
   work; never raise one. F lowers the baselines in the last commit.
7. Your final message lists: commits pushed (short SHA + one line each), files you could not finish and why, any test
   you changed and what it now pins, and any finding outside your files.
