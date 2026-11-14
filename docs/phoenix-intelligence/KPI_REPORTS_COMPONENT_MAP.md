# KPI Reports (the KPIs board) — component map

Generated from source at `origin/main` 950851277 (14 Nov 2026), the revision staging served during the
inspection runs. Every link is marked:

- **certain**: read in the file named (an import, a call, a `.from()`/`.rpc()` with a literal or a
  constant from `src/lib/crm/tables.ts`);
- **inferred**: follows from names or a helper not opened end to end; check before relying on it.

The visual explorer adds a second, independent mapping: every visible text it keeps unmasked is a string
literal from a known file, so each shot in a run's `manifest.json` carries `sourceCandidates` (file +
confidence: one file = high, several = medium). The section "Screens to files, from the run" at the end
is filled from those.

## 1. Entry points

| Address | Who reaches it | Page file | Shell | Gate in the page | Failure answer |
| --- | --- | --- | --- | --- | --- |
| `/admin/kpis?tab=…` | CEO, SFE Manager, Super Admin | `app/(admin)/admin/kpis/page.tsx` (117 lines) | admin (`src/components/layout/app-shell.tsx`) | `canSeeDoctorCoverage(role)` then `canAccess(crm_visits, read)` | redirect `/admin` |
| `/hr/admin/kpis?tab=…` | HR Resourcing | the same admin page: `proxy.ts` rewrites `/hr/*` onto the admin route and marks the HR shell (certain: the rewrite is `proxy.ts:539–542`; the reasoning is in its comments at 204–434) | HR | same | redirect `/admin` |
| `/admin/kpis/call-rate/[rep]` | as `/admin/kpis` | `app/(admin)/admin/kpis/call-rate/[rep]/page.tsx` (45) | admin / HR | same | redirect `/admin` |
| `/employee-portals/kpis?tab=summary\|am-pm\|pharmacies\|weekly` | Medical Rep, District / Regional / National Sales Manager, Product / Group Product Manager, Training / Marketing Manager | `app/employee-portals/kpis/page.tsx` (167) | employee portal (`src/components/employee-portal/employee-portal-layout.tsx`) | navigation mode must be `employee-portal` (else `/overview`), then the same two gates | "KPIs unavailable" empty state |
| `/employee-portals/kpis/call-rate` · `/coverage` · `/frequency` | portal roles above | 14-line pages, each `PortalKpiReportPage` (`src/components/crm/portal-kpi-report-page.tsx`, 122) | employee portal | same | empty state |
| `/employee-portals/kpis/call-rate/[rep]` | portal roles above | `app/employee-portals/kpis/call-rate/[rep]/page.tsx` (69) | employee portal | same | empty state |
| (loading) | — | `app/employee-portals/kpis/loading.tsx` → `PortalRouteSkeleton` | portal | — | — |

The role list is proven equal to `canSeeDoctorCoverage` by `tests/phoenix-inspect-route-inventory.test.ts`.
Access is enforced in the page (server component), not by an `assertPermission` call; there is no API
read behind the board, so the page IS the boundary (certain).

**What each role sees is cut by its scope, not only by the gate** (certain:
`src/lib/crm/doctor-coverage-roles.ts`, `BASIS_BY_ROLE`; applied by `isAgentInScope`):

| Scope | Roles | Rows on the board |
| --- | --- | --- |
| company | Super Admin, CEO, SFE Manager, Marketing Manager, Training Manager, HR Resourcing | every rep |
| line | National Sales Manager, Product Manager, Group Product Manager | the reps of their own product line |
| team | Regional Manager, District Manager | every rep beneath their seat, however many levels down |
| self | Medical Rep | their own row only |

So the same state looks different per persona, and the explorer's CEO (company) and DM (team) runs are
the two full matrices. The rep persona walks its landing state only. On the portal summary, a row's
**Coverage / Frequency / Visits** links appear only when that row has a measurable plan or visits in
the period (`summaryReportLinks`, `kpis-board-view.tsx:1498`), so a rep shot with no links in an empty
month is the board working as built, not a missing control.

## 2. Page → board

All pages are server components. Every filter, sort, period and tab is a URL parameter (certain:
`parseKpiFilters`, `KPI_TREND_PARAMS`, `resolveKpiTab`), so every state is reachable by address.

```
admin page / portal page / PortalKpiReportPage
  ├─ resolveAccessContextFromPage            src/lib/auth/server              certain
  ├─ parseKpiFilters(searchParams)           src/lib/crm/kpis-filters.ts      certain (1,249 lines)
  ├─ resolveKpiTab / PORTAL_KPI_*            src/lib/crm/kpis-tabs.ts         certain (141)
  ├─ kpiMonthOptions / kpiPeriodOptions      src/lib/crm/kpis-board.ts        certain
  ├─ getKpisBoard(access, filters)           src/lib/crm/kpis-board.ts:1303   certain (1,882 lines)
  ├─ getKpisTrend (Weekly tab only)          src/lib/crm/kpis-trend.ts        certain (632)
  ├─ resolveRepsPlansMonth                   src/lib/crm/reps-plans.ts        certain
  └─ <KpisBoardView …/>                      src/components/crm/kpis-board-view.tsx   certain (4,152 lines)
```

`call-rate/[rep]` pages render `RepVisitsPageBody` (`src/components/crm/rep-visits-page.tsx`, 329) with a
`BackToPreviousPage`, not the board (certain).

## 3. The board's components

| Component | File (lines) | What it draws | Used by | Shared beyond KPIs? |
| --- | --- | --- | --- | --- |
| `KpisBoardView` | `kpis-board-view.tsx` (4,152) | the whole board: tab strip, period picker, filter bars, tiles, podium, tables per tab, Export XLSX link (line ~451 builds `/api/crm/kpis-export?…`, line ~3624 renders it) | all pages | no |
| `KpiSection`, `KpiMeter`, `KpiBandChip`, `KpiTile`, `KpiRank`, `KpiPodiumCard`, `KpiSortableTh`, `KpiRepName`, `KpiEmptyState`, `toneOf`, `TH`/`TD`/`NUM`/`CAPTION` | `kpis-chrome.tsx` (444) | the board's visual primitives: section frames, meters, band chips, tiles, rank marks, podium cards, sortable headers, rep name links, empty state | board, trend view, report tables | **Not KPIs only.** `KpiSection` and `KpiTile` are also imported by six regional files: Team Visits, Weekly Sheet and District Manager Plans, on both `/admin/field-crm/…` and `/employee-portals/…` (certain: `git grep kpis-chrome`, 14 Nov 2026; corrected from the source dependency map) |
| `KpisFilterBar` | `kpis-filter-bar.tsx` (433, client, `useRouter`) | line / region / area / manager / title / band filters; writes the URL | board | no; uses `phxFieldClassName` from `src/components/ui/form-tokens.ts` |
| `KpisPeriodPicker` | `kpis-period-picker.tsx` (232) | month and week-of-month picker | board | no |
| `KpisDoctorFilterBar` | `kpis-doctor-filter-bar.tsx` (322) | Coverage / Frequency doctor filters, "Apply ranges" (a form submit the explorer never clicks) | board | no |
| `KpiTrendView` | `kpis-trend-view.tsx` (392) | the Weekly tab: month / quarter / semester trend by measure | board | no |
| `AmPmKpiReportTables`, `PharmacyKpiReportTables`, `OffListNote` | `kpi-reports-tables.tsx` (354) | the AM · PM and Pharmacies tabs' tables | board | no |
| coverage panels | `kpi-coverage-panels.tsx` (531), `kpi-coverage-rep-panels.tsx` (525) | Coverage tab (team and rep level) | board | no |
| frequency panels | `kpi-frequency-panels.tsx` (271), `kpi-frequency-rep-panels.tsx` (483) | Frequency tab (team and rep level) | board | no |
| `TableRowDetail`, `rowDetailToggleProps` | `src/components/ui/table-row-detail.tsx` (53) | the expandable row detail on desktop tables | board | **yes — a shared UI primitive** (blast radius: every table using row detail) |
| `PortalKpiReportPage` | `portal-kpi-report-page.tsx` (122) | the portal's Call Rate / Coverage / Frequency pages around the board | 3 portal pages | no |
| `RepVisitsPageBody` | `rep-visits-page.tsx` (329) | one rep's visits behind a call rate | both `call-rate/[rep]` pages, and nothing else (certain: its only importers) |
| shells | `app-shell.tsx`, `employee-portal-layout.tsx`, `enterprise-shell` (`EmployeePortalPageShell`, `EmployeePortalEmptyState`) | sidebar, header, page frame | every admin / portal page | **yes — every page in the system** |

## 4. Domain (all under `src/lib/crm/` unless named)

| Module | Role in the board | Certainty |
| --- | --- | --- |
| `kpis-board.ts` `getKpisBoard` | builds every figure the board shows, scoped to the viewer. **Also read by** the Business Review pack (`sources/crm-kpis.ts`), the portal home snapshot (`employee-portal/home-snapshot.ts`), the role-coverage registry and the export route, so a change to it is not KPIs only | certain |
| `call-rate-service.ts` `loadCallRateReport` | call rate per rep (AM, PM, pharmacies), working days, holidays | certain |
| `phoenix-kpi-data.ts` `loadPhoenixRepKpis` | Phoenix CRM visits' KPI inputs | certain |
| `rep-kpi-reports-data.ts` `loadRepKpiReports` | coverage and frequency per rep from assigned lists | certain |
| `kpis-doctor-bricks.ts` | doctor → brick placement for the Coverage tab | certain |
| `kpis-manager-rows.ts`, `kpis-brick-table.ts`, `kpi-index.ts`, `kpi-coverage-teams.ts`, `kpi-frequency-teams.ts` | table rows and team grouping | certain (imported by the board view) |
| `kpi-board-agents.ts` `kpiBoardDiscovery` | which reps the viewer may see | certain |
| `cutover.ts` | the date the Phoenix CRM took over from the vendor CRM | certain |
| `call-rate-holidays.ts` → `src/lib/vacation/national-holidays.ts` | confirmed national holidays for working days | certain |
| `phoenix-started-reps.ts` | when each rep started on the Phoenix CRM | certain |
| `src/lib/employees/employee-directory.ts` | names, titles, lifecycle for the rows | certain (import); its table inferred `employees` |
| `src/lib/org/manager-filter.ts` | managers above each rep (the manager filter); reads no table, it works on directory rows the board already loaded | certain |

## 5. Data read (staging and production share the schema)

| Table / view / function | Read by | Certainty |
| --- | --- | --- |
| `crm_visits_unified` (view) | `reads.ts` `queryVisits` → `call-rate-service.ts` | certain |
| `crm_checkins_unified` (view) | `reads.ts` `queryCheckins` → `call-rate-service.ts` | certain (`reads.ts:1560`) |
| `crm_contact_assignments` | `rep-kpi-reports-data.ts` | certain |
| `phx_crm_open_assignments` (function) | `rep-kpi-reports-data.ts` | certain |
| `crm_cutover` | `cutover.ts` | certain |
| `phoenix_crm_customers`, `phoenix_crm_places` | `kpis-doctor-bricks.ts` | certain |
| RPC `phoenix_crm_started_team_reps` | `phoenix-started-reps.ts:51` | certain |
| `employees` | `employee-directory.ts` | inferred |
| national holidays | `src/lib/vacation/national-holidays.ts` | inferred table name |
| `source_of_sales_regions`, `_areas`, `_bricks` | `rep-visits-data.ts` (rep drill-down) | certain |

**Writes: none from any page.** The one write the board can trigger is the Export XLSX link
(`/api/crm/kpis-export`, `app/api/crm/kpis-export/route.ts`): an `audit_logs` row through
`writeAuditLog`, rate-limit budget, and a file of real data. The explorer refuses it at three layers
(never-touch control list, click classifier, network fence) and the self-check proves the address is
never requested.

## 6. Where a visual change would land

- **Board look** (tiles, meters, chips, podium, headers, empty state): `kpis-chrome.tsx`. Every KPIs
  tab and the Weekly trend use it. **`KpiSection` and `KpiTile` also draw Team Visits, Weekly Sheet and
  District Manager Plans** (`src/components/crm/regional/`), so a change to either lands on those three
  screens too, admin and portal. The other chrome parts (meter, chip, rank, podium, headers, empty
  state) are KPIs only.
- **One tab's tables**: the matching panel file in section 3.
- **Row detail**: `src/components/ui/table-row-detail.tsx` is shared; a change there reaches every table
  that uses it outside KPIs.
- **Filters**: `kpis-filter-bar.tsx`, `kpis-doctor-filter-bar.tsx` use the form tokens
  (`src/components/ui/form-tokens.ts`); the one-form-design rule applies (AGENTS.md §4).
- **Colours, type sizes, spacing**: `src/styles/tokens.css` + `app/globals.css`, system-wide.

*Corrections from the line-level [source dependency map](KPI_REPORTS_SOURCE_DEPENDENCY_MAP.md), 14 Nov 2026: the reach of `kpis-chrome.tsx` (sections 3 and 6), `rep-visits-page.tsx`, `crm_checkins_unified`, the started-reps RPC, `manager-filter.ts`, the proxy rewrite line and `getKpisBoard`'s other readers.*

## 7. Screens to files, from the run

Filled from run `20261114-205500-kpi`'s `manifest.json` (`sourceCandidates` per shot): the CEO's admin
board only. The District Manager's portal pages were not reached (audit §5.4).

**How to read it.** A file is a **high** candidate when a text the screen shows appears, word for word, as
a string in that one file. That is a pointer, not proof. For example, `employee-portal-layout.tsx` is
"high" on admin pages because a word the admin shell shows is also written in that file. The table lists
the files that are high on **every** shot of a state.

**On all 52 shots:** `kpis-board-view.tsx`, `src/lib/crm/kpis-filters.ts`, `src/config/system-navigation.ts`,
`src/components/employee-portal/employee-portal-layout.tsx`.

| State | Shots | Also high on every shot of the state (`src/components/crm/` unless named) |
| --- | --- | --- |
| summary | 001, 002, 003 | `src/lib/crm/kpis-tabs.ts`, `kpis-filter-bar.tsx`, `kpis-period-picker.tsx`, `kpis-chrome.tsx` |
| tab-call-rate | 004, 005, 006 | `src/lib/crm/kpis-tabs.ts`, `kpis-filter-bar.tsx`, `kpis-period-picker.tsx`, `kpis-chrome.tsx` |
| tab-coverage | 007, 008, 009 | `kpi-coverage-panels.tsx`, `src/lib/crm/kpis-tabs.ts`, `kpis-filter-bar.tsx`, `kpis-period-picker.tsx`, `kpis-chrome.tsx`, `kpis-doctor-filter-bar.tsx` |
| tab-frequency | 010, 011, 012 | `kpi-frequency-panels.tsx`, `src/lib/crm/kpis-tabs.ts`, `kpis-filter-bar.tsx`, `kpis-period-picker.tsx`, `kpi-coverage-panels.tsx`, `kpis-chrome.tsx`, `kpis-doctor-filter-bar.tsx` |
| tab-am-pm | 013, 014, 015 | `kpi-reports-tables.tsx`, `src/lib/crm/kpis-tabs.ts`, `kpis-period-picker.tsx`, `kpis-filter-bar.tsx` |
| tab-pharmacies | 016, 017, 018 | `kpi-reports-tables.tsx`, `src/lib/crm/kpis-tabs.ts`, `kpis-period-picker.tsx`, `kpis-filter-bar.tsx` |
| tab-weekly | 019, 020, 021 | `kpis-trend-view.tsx`, `kpis-period-picker.tsx`, `src/lib/crm/kpis-tabs.ts`, `src/lib/crm/kpis-trend-options.ts`, `kpis-chrome.tsx`, `kpis-filter-bar.tsx` |
| call-rate-am | 022, 023, 024 | `src/lib/crm/kpis-tabs.ts`, `kpis-filter-bar.tsx`, `kpis-period-picker.tsx`, `kpis-chrome.tsx` |
| call-rate-pm | 025, 026, 027 | `src/lib/crm/kpis-tabs.ts`, `kpis-filter-bar.tsx`, `kpis-period-picker.tsx`, `kpis-chrome.tsx` |
| weekly-quarter | 028, 029, 030 | `kpis-trend-view.tsx`, `kpis-period-picker.tsx`, `src/lib/crm/kpis-tabs.ts`, `src/lib/crm/kpis-trend-options.ts`, `kpis-chrome.tsx`, `kpis-filter-bar.tsx` |
| period-week-1 | 031, 032, 033 | `src/lib/crm/kpis-tabs.ts`, `kpis-filter-bar.tsx`, `kpis-period-picker.tsx`, `kpis-chrome.tsx` |
| sorted-coverage-desc | 034, 035, 036 | `src/lib/crm/kpis-tabs.ts`, `kpis-filter-bar.tsx`, `kpis-period-picker.tsx`, `kpis-chrome.tsx` |
| filter-band-behind | 037, 038, 039 | `src/lib/crm/kpis-tabs.ts`, `kpis-filter-bar.tsx`, `kpis-period-picker.tsx`, `kpis-chrome.tsx` |
| search-no-match | 040, 041, 042 | `src/lib/crm/kpis-tabs.ts`, `kpis-period-picker.tsx`, `kpis-filter-bar.tsx` |
| empty-month | 043, 044, 045 | `src/lib/crm/kpis-tabs.ts`, `kpis-chrome.tsx`, `kpis-filter-bar.tsx`, `kpis-period-picker.tsx` |
| coverage-rep-open | 048 | `kpi-coverage-rep-panels.tsx`, `kpis-doctor-filter-bar.tsx`, `kpi-coverage-panels.tsx`, `src/lib/crm/kpis-tabs.ts`, `kpis-filter-bar.tsx`, `kpis-period-picker.tsx`, `kpis-chrome.tsx` |
| call-rate-rep | 051 | `kpi-coverage-rep-panels.tsx`, `kpi-frequency-rep-panels.tsx` (shared words only; the page itself is `app/(admin)/admin/kpis/call-rate/[rep]/page.tsx`, section 1) |
| advanced-filters-open | 052, 053 | `kpis-filter-bar.tsx`, `src/lib/crm/kpis-tabs.ts`, `kpis-period-picker.tsx`, `kpis-chrome.tsx` |
| row-detail-open | 054 | `kpi-coverage-panels.tsx`, `src/lib/crm/kpis-tabs.ts`, `kpis-filter-bar.tsx`, `kpis-period-picker.tsx`, `kpis-chrome.tsx`, `kpis-doctor-filter-bar.tsx` |
| keyboard-focus | 056, 057 | `src/lib/crm/kpis-tabs.ts`, `kpis-filter-bar.tsx`, `kpis-period-picker.tsx`, `kpis-chrome.tsx` |

The run agrees with sections 3 and 6: each tab's own panel file is high only on that tab (Coverage →
`kpi-coverage-panels.tsx`, AM · PM and Pharmacies → `kpi-reports-tables.tsx`, Weekly →
`kpis-trend-view.tsx`).
