# KPI Reports (the KPIs board) — source dependency map

This map adds detail to `KPI_REPORTS_COMPONENT_MAP.md` and does not replace it. The component map
names the files. This map follows each **visible element** down to the tables it reads.

Revision: the files were read at worktree HEAD `950851277`. `origin/main` is at `6df640b10` (14 Nov 2026).
Neither `950851277..6df640b10` nor `fb27d6a8c..6df640b10` changes any KPI, CRM-board, shell or token
file, so every line number below holds at both revisions.

## How to use this map

1. **Find the element you can see** in section 4, grouped the way the page stacks: frame, hero, tabs,
   panel header, banners, tiles, tab bodies, tables and drill-downs. The words in the "Element" column
   are the labels on screen, or a plain description where the label is data.
2. **Read the chain from left to right.** The element is drawn by a component, at a file and line. It
   reads a board field or prop, which comes from a domain function, which reads tables.
3. **Read the marks.** The `C F D T` column grades the four links in order: component and line,
   field or prop, domain function, tables.
   - `V` **verified**: an import, call, render site or `.from()` / `.rpc()` was read at that line.
   - `I` **inferred**: follows from names, types or imports, but the line was not opened end to end.
     Check it before relying on it.
   - `U` **unknown**: not found. It is listed in section 8.
   - `—` the link does not apply. Example: a hint string reads no table.
4. **Read the rules column** before changing an element. `R1`–`R12` are the locked rules in section 6,
   each with the test that pins it. A red test there is the rule doing its job: never "fix" one by
   editing the test.
5. **Read the class** in section 5 before changing a component. "KPI-specific" means only KPI pages
   import it. "Shared within CRM" and "shared across Phoenix" mean a change also reaches the other pages
   counted there.

Abbreviations used in the tables:

| Short | File |
| --- | --- |
| BV | `src/components/crm/kpis-board-view.tsx` (4,152 lines, server component) |
| CH | `src/components/crm/kpis-chrome.tsx` (444) |
| KB | `src/lib/crm/kpis-board.ts` (`getKpisBoard` at 1303) |
| KF | `src/lib/crm/kpis-filters.ts` |
| KT | `src/lib/crm/kpis-tabs.ts` |
| CRS | `src/lib/crm/call-rate-service.ts` |
| RD | `src/lib/crm/reads.ts` |

## 1. Entry pages

| Address | Page file | Builds the board at | Gate |
| --- | --- | --- | --- |
| `/admin/kpis` | `app/(admin)/admin/kpis/page.tsx` (117) | board 80, trend 77 | 54–55: `canSeeDoctorCoverage` (`src/lib/crm/doctor-coverage-roles.ts:123`) and `canAccess(crm_visits, read)`. Otherwise it redirects to `/admin`. |
| `/hr/admin/kpis` | the same page. `proxy.ts` 539–542 rewrites `/hr/*` and sets `x-phoenix-shell: hr` (`src/lib/navigation/shell-headers.ts` 14 / 61 / 78) | as above | as above |
| `/employee-portals/kpis` | `app/employee-portals/kpis/page.tsx` (167) | 152–165, inside the portal shell | navigation mode 71, refusal 76–84, `logPortalFailure` 133 |
| `/employee-portals/kpis/{call-rate,coverage,frequency}` | `PortalKpiReportPage` (`src/components/crm/portal-kpi-report-page.tsx:43`) | 77, `includeReports: false`, `tabs={[]}` | same gates |
| `/admin/kpis/call-rate/[rep]` and `/employee-portals/kpis/call-rate/[rep]` | admin 44, portal 66 | not the board: `RepVisitsPageBody` (`rep-visits-page.tsx:49`) | same gates |

## 2. The `getKpisBoard` pipeline (KB), the spine of every figure

Every board element reads a field of the `KpisBoard` object (type at KB 589) that this function returns.
The step lines are call sites inside `getKpisBoard` and were read (V) unless marked otherwise.

| KB line | Step | Calls | Reads | Mark |
| --- | --- | --- | --- | --- |
| 1330 | viewer scope | `getDoctorCoverageScope` (`doctor-coverage-scope.ts:451`) | `doctor_coverage_config`, employee directory | V |
| 1404 | `scopeReason` (refusal) | from the scope | — | V |
| 1421 | reps the viewer may see | `kpiBoardDiscovery` (`kpi-board-agents.ts`) | `crm_visits_unified`, `crm_plan_entries_unified` through `queryVisits` and `scanPlanEntries` (seen in its imports) | V call, I tables |
| 1428 | names, titles, lifecycle | `getEmployeeDirectoryRows` (`src/lib/employees/employee-directory.ts:2394`) | `employees` | V call, I table |
| 1430 | CRM cutover date | `getCrmCutoverSetting` (`cutover.ts:106`) | `crm_cutover` | V |
| 1431 | when each rep started on Phoenix CRM | `loadStartedRepWindows` (`phoenix-started-reps.ts:51`) | RPC `phoenix_crm_started_team_reps` | V |
| 1441 | Phoenix half | `loadPhoenixRepKpis` (`phoenix-kpi-data.ts:141`) | `queryVisits`, `queryCheckins`, `scanPlanEntries`, `loadPanelRows`, `loadCallRateHolidays` (seen in its imports) | V call, I tables |
| 1477 | call rate per rep | `loadCallRateReport` (CRS 111) → RD `queryVisits` 1192, `queryCheckins` 1524 | `crm_visits_unified`; `crm_checkins_unified` (select at RD 1560) | V |
| 1490 | assigned doctor lists | `getRepDoctorLists` (`rep-doctor-lists.ts:693`) → `scanPlanEntries` 446 | `crm_plan_entries_unified` | V |
| 1505 | holidays | `loadCallRateHolidays` (`call-rate-holidays.ts:74`) → `getConfirmedNationalHolidays` (`src/lib/vacation/national-holidays.ts:605`) | Google Calendar API (external), company holidays, `attendance_holiday_overrides` | V call, I/U sources |
| 1527 | managers above each rep | `buildManagersAboveByHrId` (`src/lib/org/manager-filter.ts:124`, a pure function over directory rows) | none of its own | V |
| 1544 | one row per rep | `joinKpiRows` (KB 863) | — | V |
| 1555 / 1567 | roster, then medical reps only | `kpiBoardRoster` (KB 1113), `keepMedicalRepsOnly` (`src/lib/crm/medical-rep.ts`) | — | V |
| 1586 | "just started" flag | `kpiJustStartedOf` (KF 1236) | — | V |
| 1597 | manager rows | `buildKpiManagerRows` (`kpis-manager-rows.ts:216`) | — | V |
| 1608–1611 | filter facets and filters | `buildKpiFacets` (KF 1128), `applyKpiFilters` (KF 949), manager filters (KF 1021) | — | V |
| 1639 / 1641 | doctor → brick placement | `loadKpiDoctorBricks` (`kpis-doctor-bricks.ts:153`) | `phoenix_crm_customers` (165 / 181), `phoenix_crm_places` (169 / 196) | V |
| 1650 | coverage detail | from lists and bricks | — | V |
| 1673 | AM · PM and Pharmacies reports | `loadRepKpiReports` (`rep-kpi-reports-data.ts:211`) | RPC `phx_crm_open_assignments`, `crm_contact_assignments` | V |
| 1695 / 1702 | totals, team figures | `sumKpiTeamTotals` (KB 1797), `kpiTeamFigures` (KB 1864) | — | V |
| 1740 | podium | `buildKpiPodium` (KB 775) | — | V |
| 1775 | overall KPI index | `kpiIndexOf` (`kpi-index.ts:163`) | — | V |

`getKpisBoard` writes nothing. The only write any KPI element can trigger is the Export XLSX link
(element D4).

## 3. Table index (what each read feeds)

| Table / view / function | Read at | Feeds elements | Mark |
| --- | --- | --- | --- |
| `crm_visits_unified` (view) | RD `queryVisits` 1192 | call rate tiles and tables, discovery, Phoenix half, rep visits page | V |
| `crm_checkins_unified` (view) | RD `queryCheckins` 1524, select 1560 | verified call rate, "No GPS feed" note | V (the component map had this as inferred) |
| `crm_plan_entries_unified` | `scanPlanEntries` 446 | coverage, frequency, doctor lists, plan % | V |
| `crm_contact_assignments`, RPC `phx_crm_open_assignments` | `loadRepKpiReports` 211 | AM · PM and Pharmacies tabs, list coverage | V |
| `crm_cutover` | `getCrmCutoverSetting` 106 | the board's window start | V |
| RPC `phoenix_crm_started_team_reps` | `loadStartedRepWindows` 51 | "began today" banner, not-scored marks | V (the component map had the name as inferred) |
| `phoenix_crm_customers`, `phoenix_crm_places` | `loadKpiDoctorBricks` 153 | brick tables, not-validated counts, coverage detail | V |
| `doctor_coverage_config` | `getDoctorCoverageScope` 451 | scope, refusal panel | V |
| `employees` | `getEmployeeDirectoryRows` 2394 | names, titles, hire dates, managers | I |
| `attendance_holiday_overrides`, company holidays, Google Calendar | `getConfirmedNationalHolidays` 605 | working days, holidays banner | I (company holiday table: U) |
| `source_of_sales_regions`, `_areas`, `_bricks`, plus ireports360 brick-resolution tables | `loadRepVisits` (`rep-visits-data.ts:303`) | rep visits page only | V for `source_of_sales_*`, I for the ireports360 names |
| `audit_logs` | `writeAuditLog` from `app/api/crm/kpis-export/route.ts:69` | Export XLSX (a write) | I |

## 4. Elements

Columns: **#** · **Element** · **Component** · **file:line** · **Field / props** · **Domain** · **Tables** ·
**C F D T** · **Rules**. "Board" means the `KpisBoard` object from section 2.

### 4.1 Frame, gates and failure answers

| # | Element | Component | file:line | Field / props | Domain | Tables | C F D T | Rules |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A1 | Admin sidebar and header | `AppShell` | `src/components/layout/app-shell.tsx:41`, mounted in `app/(admin)/layout.tsx:77` (shell mode 51); class `admin-shell` at 192 | access context, shell mode | `resolveAccessContextFromPage` | — | V I I — | R3 |
| A2 | HR shell variant of the same page | `AppShell` in HR mode | `proxy.ts` 539–542; `shell-headers.ts` 14 / 61 / 78 | `x-phoenix-shell: hr` header | — | — | V V — — | R3 |
| A3 | Portal sidebar and header | `EmployeePortalLayout` | `src/components/employee-portal/employee-portal-layout.tsx:2289` / 2486, via `app/employee-portals/layout.tsx` (`server-shell`) | access context | — | — | V I — — | R3 |
| A4 | Portal page frame and title | `EmployeePortalPageShell` | `enterprise-shell` 118; used at portal page 152–165 | title props | — | — | V V — — | R3 |
| A5 | Loading skeleton | `PortalRouteSkeleton`, shape `"dashboard"` | `skeleton-templates` 317; the 4 KPI `loading.tsx` files | shape | — | — | V V — — | R3 |
| A6 | Redirect away (admin, no screen) | admin page | `app/(admin)/admin/kpis/page.tsx` 54–55 | role | `canSeeDoctorCoverage` (`doctor-coverage-roles.ts:123`), `canAccess` | — | V V V — | R12 |
| A7 | "KPIs could not load." | admin page | admin page 98 | caught board error | `getKpisBoard` | — | V I V — | — |
| A8 | "KPIs Unavailable" | `EmployeePortalEmptyState` | `enterprise-shell` 199; portal page 76–84 | refusal reason | `logPortalFailure` (portal page 133) | — | V V V — | R12 |
| A9 | Scope refusal panel (viewer outside the KPI scope) | inline | BV 3506–3507 | `board.scopeReason` | KB 1404 ← `getDoctorCoverageScope` | `doctor_coverage_config`, `employees` | V V V I | — |

### 4.2 Hero (`KpiHero`, BV 587, rendered at 3594)

| # | Element | Component | file:line | Field / props | Domain | Tables | C F D T | Rules |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B1 | Kicker and page title (admin only) | `KpiHero` | BV 587, 3594 | `showTitle={chrome === "admin"}`, `solo` | — | — | V V — — | R3 |
| B2 | Caption: scope · month · period | `KpiHero` | BV 615 | `board.scopeLabel`, `board.monthLabel`, `board.range.periodLabel` | KB scope 1330; period options KB 181 | — | V V I — | — |
| B3 | Team standing pill | `KpiHero` + `teamVerdict` | BV 484 | board totals, KPI index; colour from `tone.chip` (`TONES`, CH 60) | `kpiIndexOf` via KB 1775 | derived from every read | V I I I | R3 |
| B4 | Hero rail (admin only) | `KpiHero` | BV 587 | `chrome === "admin"` | U | — | V V U — | R3 |

### 4.3 Tab strip

| # | Element | Component | file:line | Field / props | Domain | Tables | C F D T | Rules |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C1 | Tab labels (hidden when there are no tabs, as on portal report pages) | `KpiTabStrip` | BV 793, labels 838, rendered 3600 | `KPI_TAB_LABEL` (KT 35), `KPI_TABS` (KT 30), `PORTAL_KPI_SUMMARY_TABS` (KT 87) | `resolveKpiTab` (KT 138) | — | V V V — | — |
| C2 | Headline figure under each tab | `tabHeadline` | BV 714 | `board.reps` measures | KB totals 1695 | all measure reads | V I I I | R2 |
| C3 | List-coverage note on the AM · PM and Pharmacies tabs | `listCoverage` | BV 758 | `board.kpiReports` | `loadRepKpiReports` (KB 1673) | `crm_contact_assignments`, RPC `phx_crm_open_assignments` | V V V V | R1 |

### 4.4 Panel header (`PANEL` frame, BV 3601)

| # | Element | Component | file:line | Field / props | Domain | Tables | C F D T | Rules |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| D1 | Tab title | inline | BV 3604 | `KPI_TAB_LABEL[tab]` | KT 35 | — | V V V — | R6 |
| D2 | Tab hint sentence | inline | BV 3606 | `KPI_TAB_HINT_PHOENIX[tab]` (KT 73) ?? `KPI_TAB_HINT[tab]` (KT 54) | — | — | V V V — | — |
| D3 | Panel caption: scope · month · period | inline | BV 3610–3611 | as B2 | as B2 | — | V V I — | — |
| D4 | **Export XLSX** link (shown only when there are reps) | `<a download>` | BV 3616–3626; `kpisExportHref` BV 448 | `buildKpisQuery` (KF 780) | `/api/crm/kpis-export`: gate 36, `getKpisBoard` 55, workbook 64 (`kpis-board-workbook.ts`, `KPI_EXPORT_MARKERS` 57), `writeAuditLog` 69 | **writes** `audit_logs` | V V V I | R2, R11 |
| D5 | Call-rate view switch (call-rate tab only) | `CallRateViewSwitch` | BV 2886 (headline 2871, hint 2878), rendered 3630 | `context` view parameter | — | — | V V — — | R1 |
| D6 | Month and period picker | `KpisPeriodPicker` | `kpis-period-picker.tsx:50` (`CONTROL_CLASS` 46), rendered BV 3633 | month and period options | `kpiMonthOptions` (KB 151), `kpiPeriodOptions` (KB 181) | — | V V V — | R8, R9 |
| D7 | Filter bar and its "Advanced filters" toggle (hidden for a solo viewer with no filter) | `KpisFilterBar` (client) | `kpis-filter-bar.tsx:150`, toggle 266–282, rendered BV 3656 | facets from KB 1608 | `parseKpiFilters` (KF 705), `applyKpiFilters` (KF 949), manager filters (KF 1021) | `employees` | V V V I | R6, R8, R9 |
| D8 | Active filter chips | `ActiveFilterChips` | BV 866, rendered 3672 | `context.filters`, `hasActiveKpiFilters` (KF 645) | — | — | V V V — | R3 |

### 4.5 Caveat banners

| # | Element | Component | file:line | Field / props | Domain | Tables | C F D T | Rules |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| E1 | Holidays not confirmed yet | inline | BV 3677 | `board.holidaysComplete` | `loadCallRateHolidays` (KB 1505) → `getConfirmedNationalHolidays` 605 | Google Calendar, `attendance_holiday_overrides`, company holidays | V V V I | — |
| E2 | "No GPS feed" note | inline + `NO_GPS_FEED` (BV 230) | BV 3695 | `board.noGpsFeedShown` | `hasNoGpsFeed` (`call-rate.ts:470`) | `crm_checkins_unified` | V V V I | R2 |
| E3 | KPI rules note | inline | BV 3710–3712 | `board.kpiRulesNote` (type KB 718) | U: the line that sets it was not found | — | V V U — | — |
| E4 | Period not started yet | inline | BV 3716–3718 | `board.range.notStarted` | period range (KB 181) | — | V V I — | — |
| E5 | Rep began today | inline | BV 3724 | `justStarted` (KB 1586) | `loadStartedRepWindows` (KB 1431), `kpiJustStartedOf` (KF 1236) | RPC `phoenix_crm_started_team_reps` | V I V V | R2 |

### 4.6 Overall panel, tiles and empty states

| # | Element | Component | file:line | Field / props | Domain | Tables | C F D T | Rules |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F1 | Overall KPI panel with formula and method (not on report pages) | `KpiOverallPanel` | BV 663, rendered 3738 | `board.kpiIndex.formula`, `.method` | `kpiIndexOf` (KB 1775) | derived | V V V — | R2 |
| F2 | Overall meter and band chip | `KpiMeter` (CH 162), `KpiBandChip` (CH 174) | BV 678, 701 | index value, `kpiBandOf` (KF 131) | — | — | V V V — | R3 |
| F3 | Session tiles (call-rate session view) | `CallRateSessionTiles` | BV 2954 (`sessionFigures` 2934), rendered 3750 | `board.reps`, session | `loadCallRateReport` (KB 1477) | `crm_visits_unified`, `crm_checkins_unified` | V V V V | R1, R2 |
| F4 | "Working days" tile | `KpiTile` (CH 196) | BV 3762 | `workingDays` (KB 598) | KB 1477 and 1505 | holiday sources | V I V I | R2 |
| F5 | "Medical reps shown" / "Medical reps in reach" tile | `KpiTile` | BV 3774 | rep count after roster (KB 1555) and medical-reps-only (KB 1567) | `getEmployeeDirectoryRows` (KB 1428) | `employees` | V I V I | — |
| F6 | Measure tiles row (call rate, plan, coverage, frequency, pharmacies) | `KpiTile` in grid BV 3752 | BV 3756–3848 | totals and team figures | `sumKpiTeamTotals` (KB 1797), `kpiTeamFigures` (KB 1864) | every measure read | V I V I | R1, R2, R4 |
| F7 | Coverage extra tiles | `kpiCoverageExtraTiles` (`kpi-coverage-panels.tsx:234`) → `KpiTile` | BV 3840 | board | — | assignments, plans | V V I I | R2 |
| F8 | Frequency extra tiles | `kpiFrequencyExtraTiles` (`src/lib/crm/kpi-frequency-teams.ts:257`) → `KpiTile` | BV 3847–3848 | board | same | assignments, plans | V V V I | R2 |
| F9 | Phoenix totals caption | inline | BV 3855–3857 | `board.phoenixTotals` | `applyPhoenixKpis` (KB 1240) ← `loadPhoenixRepKpis` (KB 1441) | visits, check-ins, plan entries | V V V I | — |
| F10 | Call-rate total counts | `CallRateTotalCounts` | BV 3002, rendered 3870 | board | `loadCallRateReport` | `crm_visits_unified`, `crm_checkins_unified` | V I V V | R1 |
| F11 | "No reps match these filters." | `KpiEmptyState` (CH 436) | BV 3886 | filtered, no reps | `applyKpiFilters` | — | V V V — | — |
| F12 | "No reps in this period." | `KpiEmptyState` | BV 3891 | no reps | roster (KB 1555) | — | V V I — | — |

### 4.7 Tab bodies

| # | Element | Component | file:line | Field / props | Domain | Tables | C F D T | Rules |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 | Weekly tab: month, quarter and semester trend | `KpiTrendView` | `kpis-trend-view.tsx:312`, rendered BV 3897 | `trend` from the admin page (77) | `getKpisTrend` (`kpis-trend.ts:484`), which imports `kpis-board` and `mapWithConcurrency` | as the board, once per column (I) | V V V I | R6 |
| G2 | AM · PM report tables | `AmPmKpiReportTables` | `kpi-reports-tables.tsx:289`, BV 3918 | `board.kpiReports`, `board.reps` | `loadRepKpiReports` (KB 1673) | `crm_contact_assignments`, RPC `phx_crm_open_assignments` | V V V V | R1, R4 |
| G3 | Pharmacies report tables | `PharmacyKpiReportTables` | `kpi-reports-tables.tsx:319`, BV 3919 | same | same | same | V V V V | R1, R4 |
| G4 | Off-list note | `OffListNote` | `kpi-reports-tables.tsx:344`, BV 3921 | `board.kpiReports` | same | same | V V V V | — |
| G5 | Coverage standing and team roll-up | `KpiCoverageStanding` (`kpi-coverage-panels.tsx:193`), `KpiTeamCoverageRollup` (315) | BV 3935, 3936 | `board`, `board.coverageFloorPct`, coverage teams | `groupKpiRepsByTeam` 101, `kpiTeamCoverage` 151 (`kpi-coverage-teams.ts`) | plans, assignments | V V I I | R2, R3 |
| G6 | Frequency standing and team roll-up | `KpiFrequencyStanding` (`kpi-frequency-panels.tsx:76`), `KpiTeamFrequencyRollup` (132) | BV 3954, 3955 | `board`, frequency teams | `kpiTeamsWithFrequency` (`kpi-frequency-teams.ts:96`) | plans, visits | V V V I | R2, R6 |
| G7 | "Standing out" podium | `KpiPodiumCard` (CH 267), `KpiRank` (CH 235) | BV 3967–4004 | board podium | `buildKpiPodium` (KB 775, called at 1740); just-started reps are never ranked (KB 786–787) | derived | V V V — | R2, R3 |

### 4.8 Tables, phone cards and row drill-downs

| # | Element | Component | file:line | Field / props | Domain | Tables | C F D T | Rules |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| H1 | Phone rep cards | `RepCard` | BV 2132, rendered 4044 in the `md:hidden` list at 4017 | `board.reps` row | `joinKpiRows` (KB 863) | every read | V V V I | R4, R10 |
| H2 | Phone session cards | `SessionCard` | BV 3128, rendered 4036 | row, session | `loadCallRateReport` | visits, check-ins | V V V V | R1, R10 |
| H3 | Summary table, sortable headers | `SummaryTable`, `RepNameTh` (BV 1076), `KpiSortableTh` (CH 345) | BV 1091, rendered 4077 | `board.reps`; `sortHref` (BV 435), `nextKpiSort` (KF 862) | `joinKpiRows` | every read | V V V I | R3, R4 |
| H4 | Overall cell | `OverallCell` | BV 1220 | `repKpiIndex` (BV 298), `overallValue` (BV 342), `overallCaption` (BV 349) | `kpiIndexOf` | derived | V V I — | R2 |
| H5 | Measure cell (AM %, PM %, plan %, pharmacies) | `MeasureCell` | BV 959 | `rate` 220, `planPct` 253, `amPct` 265, `pmPct` 272, `pharmacyValue` 285, `NOT_SCORED_YET` 236 | `isTooEarlyToScore` (KF 1214) | visits, plans | V V I I | R1, R2 |
| H6 | Rep name, hire date and flags | `RepCell` → `KpiRepName` (CH 394) | BV 1011, `KpiRepName` at 1035 | identity, hire date (`utcDate`), `kpiFlagsShownOn` (KF 316), `kpiFlagLabel` (KF 259), `KPI_FLAGS_OFF_REPORT` (KF 299) | `getEmployeeDirectoryRows` | `employees` | V V V I | — |
| H7 | Call-rate table | `CallRateTable` | BV 1233, rendered 4082 | `board.reps` | `loadCallRateReport` | `crm_visits_unified`, `crm_checkins_unified` | V V V V | R1, R4 |
| H8 | Call-rate session table | `CallRateSessionTable` | BV 3024, rendered 4080 | `board.reps`, session | same | same | V V V V | R1, R4 |
| H9 | Visits link to the rep drill-down | `callRateVisitsLink` | BV 1472 | rep route (`kpis-call-rate-route`) | — | — | V I I — | — |
| H10 | "Not validated" link | `notValidatedLink` | BV 1432 | `notValidatedDoctors` (KB 512), `awaitingValidationNote` (`call-rate.ts:462`) | `loadKpiDoctorBricks` | `phoenix_crm_customers`, `phoenix_crm_places` | V V V V | R2 |
| H11 | Coverage table with team heading rows | `CoverageTable`, `KpiTeamHeadingRow` (`kpi-coverage-panels.tsx:411`) | BV 1863, heading 1934, rendered 4085 | `board.reps`, coverage teams | `getRepDoctorLists` (KB 1490), `loadRepKpiReports` | `crm_plan_entries_unified`, `crm_contact_assignments` | V V V V | R2, R4 |
| H12 | Coverage floor badge | `coverageFloorBadge` | BV 989 | `FLOOR` (KF 153), `coverageBandOf` (KF 140) | — | — | V V V — | R2 |
| H13 | Team heading bands on phone | `KpiTeamHeadingBand` (`kpi-coverage-panels.tsx:422`), `KpiFrequencyTeamHeadingBand` (`kpi-frequency-panels.tsx:245`) | BV 4021, 4023 | team entry | `kpiTeamCoverage`, `kpiTeamsWithFrequency` | — | V V I — | R10 |
| H14 | Coverage row toggle | `coverageDoctorsToggle` + `rowDetailToggleProps` (`table-row-detail.tsx:28`) | BV 1407 / 1413 | row id, open state | — | — | V V — — | R5 |
| H15 | Coverage row detail (joined panel, 6 columns) | `TableRowDetail` (`table-row-detail.tsx:32`) | BV 1965, `colSpan` 6 | coverage detail (KB 1650) | `getRepDoctorLists`, `loadKpiDoctorBricks` | `crm_plan_entries_unified`, `phoenix_crm_customers`, `phoenix_crm_places` | V V V V | R5 |
| H16 | Coverage doctor lists (desktop and phone) | `CoverageDoctors`, `CoverageListCard`, `CoverageDoctorName` | BV 1655, 1575, 1538; rendered 1966 and 4068 | detail, `surface` | same | same | V V V V | R4 |
| H17 | Coverage summary: by week, grade, speciality, brick | `CoverageSummary` → `KpiCoverageWeekTable` (`kpi-coverage-rep-panels.tsx:514`), `KpiCoverageGroupTable` (417), `BrickBreakdown` | BV 2462, rendered 1798; tables 2508–2512 | detail, `board.asOf` | `kpiCoverageByWeek` (`kpi-coverage-rep-detail.ts:362`), `buildKpiBrickRows` | plans, places | V V V V | R2, R4 |
| H18 | Rep coverage tiles, floor track, late ageing, floor path, visit depth | `KpiRepCoverageTiles` 91, `KpiFloorTrack` 126, `KpiLateAgeingPanel` 192, `KpiFloorPathPanel` 280, `KpiRepVisitDepth` 345 (`kpi-coverage-rep-panels.tsx`) | BV 2483–2496 | coverage summary | coverage detail | plans, visits | V V I I | R3, R7 |
| H19 | Doctor filters with "Apply ranges" | `DoctorFilters` → `KpisDoctorFilterBar` | BV 1606, rendered 2847; `kpis-doctor-filter-bar.tsx:60`, form 149 | doctor filter state | `kpis-doctor-filters.ts` 172 / 275 / 363 / 395 | — | V V V — | R8, R9 |
| H20 | Frequency table with team heading rows | `FrequencyTable`, `KpiFrequencyTeamHeadingRow` (`kpi-frequency-panels.tsx:234`) | BV 1977, heading 2081, rendered 4086 | `board.reps`, frequency teams | `kpiTeamsWithFrequency` | plans, visits | V V V I | R4 |
| H21 | Frequency row detail (joined panel, 5 columns) | `TableRowDetail` | BV 2113, `colSpan` 5 | frequency detail | as H15 | as H15 | V V V V | R5 |
| H22 | Frequency doctor lists and status chips | `FrequencyDoctors`, `FrequencyDoctorName`, `FrequencyStatusChip`, `frequencyRows` | BV 2611, 2587, 2542, 2573; rendered 2114 and 4066 | detail | same | plans, visits | V V V I | R3 |
| H23 | Rep frequency tiles, track, short-depth, first-visit, by week, by speciality | `KpiRepFrequencyTiles` 89, `KpiFrequencyTrack` 133, `KpiShortDepthPanel` 202, `KpiFrequencyFirstPanel` 262, `KpiFrequencyWeekTable` 471, `KpiFrequencyGroupTable` 370 (`kpi-frequency-rep-panels.tsx`) | BV 2781, 2782, 2801–2802, 2828, 2837 | frequency summary, `phoenix` | frequency detail | plans, visits | V V I I | R6, R7 |
| H24 | Team bricks section and brick glance | `TeamBricksSection` → `KpiBrickGlance` (`kpi-coverage-panels.tsx:458`), `BrickBreakdown` (BV 2311) | BV 2430, 2437, 2439; rendered 4091 | `board.teamBricks` | `buildKpiBrickRows` (`kpis-brick-table.ts:116`, KB 515), `loadKpiDoctorBricks` | `phoenix_crm_customers`, `phoenix_crm_places` | V V V V | R2 |
| H25 | Managers table (desktop) | `ManagersSection` → `ManagersTable`, `ManagerName`, `HEAD_SUB` | BV 3437, 3265, 3243, 3205; rendered 4096 and 3452 | `board.managers` | `buildKpiManagerRows` (KB 1597), `LEVEL_LABEL` (`kpis-manager-rows.ts:46`), managers above (KB 1527) | `employees` + every measure | V V V I | R2, R4 |
| H26 | Manager cards (phone) | `ManagerCard` | BV 3355, rendered 3448 in `md:hidden` 3446 | manager row | same | same | V V V I | R10 |
| H27 | Report links on the portal summary page | `summaryReportLinks` | BV 1498 | `PORTAL_KPI_REPORT_PATH` (KT 99), `PORTAL_KPIS_ROOT_PATH` (KT 106) | — | — | V V V — | — |
| H28 | Footer: "Coverage and frequency are scored for" (month) "to" (day) | inline | BV 4116–4117 | `board.monthLabel`, `board.asOf` | — | — | V V I — | — |
| H29 | Band legend | inline + `KpiBandChip` | BV 4134–4144 | band labels (KF 113 / 122) | `kpiBandOf` and the band functions (KF 131–177) | — | V V V — | R3 |

### 4.9 Drill-down pages

| # | Element | Component | file:line | Field / props | Domain | Tables | C F D T | Rules |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| I1 | Portal Call Rate / Coverage / Frequency page | `PortalKpiReportPage` | `portal-kpi-report-page.tsx:43`, board 77 | `includeReports: false`, `tabs={[]}` | `getKpisBoard` | as section 2 | V V V V | R12 |
| I2 | Back link | `BackToPreviousPage` | `portal-kpi-report-page.tsx:108`; both `call-rate/[rep]` pages | — | — | — | V — — — | — |
| I3 | One rep's visits behind a call rate | `RepVisitsPageBody` → `RepVisitsDetail` (`rep-visits-detail.tsx:242`) | `rep-visits-page.tsx:49`; admin page 44, portal page 66 | rep route parameter | `loadRepVisits` (`rep-visits-data.ts:303`), `repsPlansRange` (`reps-plans.ts:251`) | `source_of_sales_*`, ireports360 brick tables, visits | V V V I | R4 |

## 5. Component classes, proved by importer counts

Counts are `git grep` over `src/` and `app/` for an import of the file. Do not use the shell's `grep`
here: in this repository it is a wrapper that skips folders named `coverage`, `.claude` and `_wt-*`, so
it silently drops `kpi-coverage-*` hits. Use `git grep` or `command grep`.

### 5.1 UI

| File | Importers | Who imports it | Class |
| --- | --- | --- | --- |
| `kpis-board-view.tsx` | 3 | admin page, portal page, `portal-kpi-report-page` | KPI-specific |
| `portal-kpi-report-page.tsx` | 3 | the three portal report pages | KPI-specific |
| `kpis-filter-bar.tsx`, `kpis-period-picker.tsx`, `kpis-doctor-filter-bar.tsx`, `kpis-trend-view.tsx`, `kpi-reports-tables.tsx`, `kpi-coverage-rep-panels.tsx`, `kpi-frequency-panels.tsx`, `kpi-frequency-rep-panels.tsx` | 1 each | the board view | KPI-specific |
| `kpi-coverage-panels.tsx` | 4 | KPI files only | KPI-specific |
| `rep-visits-page.tsx` | 2 | the two `call-rate/[rep]` pages only | KPI-specific |
| `rep-visits-detail.tsx` | 1 | `rep-visits-page` | KPI-specific |
| **`kpis-chrome.tsx`** | **11** | 5 KPI files plus 6 regional files: `src/components/crm/regional/{district-manager-plans,team-visits,weekly-sheet}-{view,panels}.tsx`, which serve Team Visits, Weekly Sheet and District Manager Plans in admin and the portal | **shared within CRM** |
| `src/components/crm/back-to-previous-page.tsx` | 5 | Employee 360, field-CRM day, manager day, KPI call-rate drill-down, portal KPI report page | shared across Phoenix |
| `src/components/ui/table-row-detail.tsx` | 31 | admin, attendance, CRM integrity, CRM master, regional weekly sheet, devices, double visit, portal, hiring documents (3), HR operations reports, marketing, outstation (4), Phoenix CRM (3), recruitment (2), sales (4) | shared across Phoenix |
| `src/components/admin/admin-design-tokens.ts` | 276 | system-wide | shared across Phoenix |
| `src/components/ui/form-tokens.ts` | 378 | system-wide | shared across Phoenix |
| `src/components/employee-portal/enterprise-shell.tsx` | 146 | system-wide | shared across Phoenix |
| `src/components/employee-portal/skeleton-templates.tsx` | 165 | system-wide | shared across Phoenix |
| `src/lib/utils.ts` (`cn`, `extendTailwindMerge`) | 458 | system-wide | shared across Phoenix |
| `app-shell.tsx` | 2 | `app/(admin)/layout.tsx`, `app/payslips`. The admin layout mounts it for **every** admin page | shared across Phoenix |
| `employee-portal-layout.tsx` | 4 | `employee-portal-server-shell.tsx` (the portal layout), `app/payslips`, two `app/dev/employee-portals` pages | shared across Phoenix (portal) |

The `kpis-chrome.tsx` exports reached most often from outside the board: `CAPTION`, `TH`, `TD`, `NUM`,
`toneOf`, `KpiTile` and `KpiMeter` (in each coverage and frequency rep panel), `KpiRepName` (in the
report tables and the trend view), and `KpiSection` and `KpiTile` (in the regional files). `FLAT` (CH 101,
`shadow-none`) is internal.

### 5.2 Domain

| Module | Importers | Outside the KPI board | Class |
| --- | --- | --- | --- |
| `kpis-board.ts` | 22 | Business Review `sources/crm-kpis.ts` (`getKpisBoard` 131), portal home `employee-portal/home-snapshot.ts` (1059 / 1066), `admin/role-coverage/registry.ts` (105 / 127), the export route (55), reps list board and vacant areas (`kpiMonthOptions` only) | shared across Phoenix |
| `kpis-filters.ts` | 20 | none | KPI-specific |
| `reps-plans.ts` | 7 | none | KPI-specific |
| `kpis-doctor-bricks.ts` | 2 | `validated-place-points` | shared within CRM |
| `kpis-call-rate-route` | 12 | reps list and reps plans pages | shared within CRM |
| `call-rate` | 29 | 25 of them | shared beyond KPIs |
| `reads.ts` | 57 | most of them | shared across CRM and beyond |
| `doctor-coverage-scope` / `doctor-coverage-roles` | 17 / 16 | not listed one by one | shared beyond KPIs (I) |
| `cutover`, `rep-doctor-lists`, `call-rate-holidays` | 13 / 11 / 11 | not listed one by one | shared beyond KPIs (I) |

A change to `getKpisBoard` reaches the Business Review pack, the portal home snapshot and the
role-coverage registry, not only this board.

## 6. Locked rules and the tests that pin them

| Id | Rule | Pinned by | Governs |
| --- | --- | --- | --- |
| R1 | AM, PM and Pharmacies are never blended into one figure | `tests/kpis-filters.test.ts:514` `runKpiAttainmentAndIdentityTests`; `tests/kpis-reports-split.test.ts:61` `runKpisReportsSplitTests` | C3, D5, F3, F6, F10, G2, G3, H2, H5, H7, H8 |
| R2 | A marker word (`NOT_SCORED_YET`, `NO_GPS_FEED`) is never shown as 0 | `tests/kpis-board-workbook.test.ts:192`, `tests/kpis-full-roster.test.ts:56`, `tests/kpis-filters.test.ts:726` `runKpiManagerRowChecks`, `tests/kpis-no-gps-feed.test.ts:97`, `tests/kpis-brick-table.test.ts:53` | C2, D4, E2, E5, F1, F3–F8, G5–G7, H4, H5, H10–H12, H17, H24, H25 |
| R3 | Square edges, no round corners (`globals.css` 1180 admin, 1306 portal) | `tests/admin-shell-palette-scope.test.ts`, `tests/square-edge-golden-rule.test.ts:410`, `tests/kpi-coverage-premium.test.ts` | A1–A5, B1, B3, B4, D8, F2, G5, G7, H3, H18, H22, H29 |
| R4 | Fits the screen, no horizontal scroll at any width | `tests/kpis-board-tables-fit.test.ts:316`, `tests/fits-the-screen-ratchet.test.ts:262` | F6, G2, G3, H1, H3, H7, H8, H11, H16, H17, H20, H25, I3 |
| R5 | The row detail is a joined panel (row-detail exception in `globals.css` 1210 / 1436) | `tests/table-row-detail-joined.test.ts:40`, `tests/table-structure-ratchet.test.ts`, `tests/admin-shell-palette-scope.test.ts` §7 | H14, H15, H21 |
| R6 | A `text-phx-*` size never goes through `cn()`, or tailwind-merge strips it (trap `tailwind-merge-strips-custom-named-font-sizes`; scale `globals.css` 164–174 → `tokens.css` 210–220) | `tests/kpis-trend.test.ts:402`, `tests/kpi-frequency-premium.test.ts:627`, `tests/kpi-frequency-rep-detail.test.ts:435` | D1, D7, G1, G6, H23 |
| R7 | 11px font floor | `tests/team-visits-premium.test.ts:740` (a regional test; it reaches the KPI elements through the shared `kpis-chrome` (I)) | H18, H23 and every `CAPTION` / `TH` use |
| R8 | No function prop crosses into a client component | `tests/rsc-client-function-props.test.ts:492` | D6, D7, H19 |
| R9 | One form design: fields use `phxFieldClassName` (`form-tokens.ts:29`) and `phxSelectClassName` (33) | `tests/form-design-system.test.ts` (ratchet at zero) | D6, D7, H19 |
| R10 | Desktop shows tables, a phone shows cards (AGENTS.md §4) | U: no dedicated test found | H1, H2, H13, H26 |
| R11 | The inspection explorer never requests the export address | `tests/phoenix-inspect-fence.test.ts`, `tests/phoenix-inspect-safety.test.ts` (new on this branch; assertions not re-read for this map (I)) | D4 |
| R12 | The KPI role list equals `canSeeDoctorCoverage` | `tests/phoenix-inspect-route-inventory.test.ts` | A6, A8, I1 |

## 7. Corrections to `KPI_REPORTS_COMPONENT_MAP.md`

Where the two disagreed, this map was read later and at line level. **All seven corrections below were applied to the component map on 14 Nov 2026**:

- **`kpis-chrome.tsx` is not "KPIs only".** It has 11 importers, 6 of them regional field-CRM screens
  (section 5.1). Its section 6 statement "Every KPIs tab and the Weekly trend use it, nothing else does"
  is wrong: a chrome change also moves Team Visits, Weekly Sheet and District Manager Plans.
- **`rep-visits-page.tsx` is not inferred to serve Reps Plans.** Its only importers are the two
  `call-rate/[rep]` pages.
- **`crm_checkins_unified` is verified, not inferred**: the select is at `reads.ts:1560`.
- **The started-reps function name is verified**: RPC `phoenix_crm_started_team_reps`
  (`phoenix-started-reps.ts:51`).
- **`src/lib/org/manager-filter.ts` reads no table.** `buildManagersAboveByHrId` (124) works on directory
  rows that `getKpisBoard` already loaded.
- **The HR rewrite is at `proxy.ts` 539–542.** The component map cites only the comments at 204–434.
- **`getKpisBoard` has consumers outside the board** (section 5.2). The component map lists none.

## 8. Unknowns

1. **E3 KPI rules note**: the field is typed at KB 718, but the line inside `getKpisBoard` that sets it
   was not found.
2. **B4 hero rail**: what the rail shows and where its figures come from were not opened.
3. **F4–F6 tiles**: which `totals` or team-figure field feeds which tile between BV 3756 and 3848 was
   not read tile by tile. `workingDays` (KB 598) is the likely source of F4.
4. **`employees` table**: inferred from the name of `getEmployeeDirectoryRows` (employee directory 2394).
   The `.from()` was not opened.
5. **Company holiday table**: `getConfirmedNationalHolidays` (605) reads the Google Calendar API and
   `attendance_holiday_overrides`. The table name for company holidays is unknown.
6. **Phoenix half tables**: `loadPhoenixRepKpis` imports `queryVisits`, `queryCheckins`,
   `scanPlanEntries` and `loadPanelRows`. Which of these the function itself calls, and what
   `loadPanelRows` reads, were not traced.
7. **`getKpisTrend`**: it imports `kpis-board` and `mapWithConcurrency`. That it builds one board per
   trend column is inferred.
8. **Rep visits page**: the ireports360 brick-resolution table names inside `loadRepVisits` (303) are
   inferred.
9. **`audit_logs`**: the table written inside `writeAuditLog` is inferred from the component map.
10. **R10 (desktop tables, phone cards)** has no dedicated test that was found. The fits-the-screen
    tests may cover it in part.
11. **R11**: the inspection fence and safety tests are new on this branch. Their assertions
    about the export address were not re-read for this map.
12. **HR shell**: whether `x-phoenix-shell: hr` changes any board element beyond the shell
    (`chrome === "admin"` is assumed for HR) was not traced.
13. **Section 7 of the component map** ("Screens to files, from the run") is still unfilled. Visible text
    has not been matched to these element ids by a run's `sourceCandidates`.
