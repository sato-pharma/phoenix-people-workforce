# Phoenix Workforce Production-Build Scorecard

Date: 2026-05-18

## Scope

This scorecard is intentionally focused on production-build readiness:

- database/data logic
- workflow completeness
- source-of-truth clarity
- module linkage
- UI/API/service separation
- business-rule test coverage
- operational readiness for building the product

Out of scope for this scorecard:

- security hardening
- RLS hardening
- auth policy hardening
- penetration/privacy review
- deployment/firewall review

Those are important later, but they are not the current build priority.

## How To Read Scores

Each area is scored from 1 to 5.

- 5 = strong, production-shaped, clear owner
- 4 = good, minor consolidation needed
- 3 = usable, but logic can drift or boundary is unclear
- 2 = weak, needs planned refactor before scaling
- 1 = missing or mostly page/component-driven

The module score is an average, rounded to one decimal.

## What I Check Inside Every Module

| Area | What is checked |
|---|---|
| Data model ownership | Does the module have clear DB tables/views and typed DTOs? |
| Workflow completeness | Are create/update/approve/reject/import/export flows complete and understandable? |
| Source of truth | Is the business logic in one service, or duplicated in pages/components? |
| Cross-module linkage | Does it correctly affect and consume related modules? |
| UI/API/service separation | Are pages/components mostly display, with APIs/services owning logic? |
| Test coverage | Are important calculations/transitions covered by tests? |
| Production readiness | Can this module be used and maintained without constant manual correction? |

## Executive Priority Summary

| Priority | Workstream | Why it matters now |
|---|---|---|
| P0 | Workforce source of truth | Employee/vacancy/structure logic is the root of many modules. Fix first. |
| P0 | Platform metrics aggregator | Command Center and Overview should not each calculate business metrics. |
| P1 | Sales dashboard metric extraction | Sales KPIs are partially calculated in UI, which creates drift risk. |
| P1 | Expenses dashboard service boundary | Expense dashboard aggregation is too component/page-driven. |
| P1 | Lifecycle-to-workforce regression tests | Offers/resignations/probation/contracts must update workforce state predictably. |
| P2 | HR Calendar service | Calendar rules need a clear service owner. |
| P2 | CV/candidate service | CV Database works, but candidate workflow ownership is unclear. |
| P2 | Standard mutation audit contract | Workflow side effects should be consistently traceable later. |

## Module Scorecard

### Command Center

| Area | Score | Finding | Build action |
|---|---:|---|---|
| Data model ownership | 3 | Aggregates many domains but owns local DTOs. | Keep DTO, but feed it from platform metrics. |
| Workflow completeness | 4 | Good executive surface. | No major UX blocker. |
| Source of truth | 2 | Still calculates sales, expense, offer, contract, and probation metrics locally. | Move calculations to domain metric services. |
| Cross-module linkage | 3 | Uses many services, but not consistently. | Create `getPlatformMetrics()`. |
| UI/API/service separation | 4 | Component mostly renders DTO. | Keep this pattern. |
| Test coverage | 2 | No direct command center metric regression coverage. | Add aggregator tests. |
| Production readiness | 3 | Usable, but drift risk remains. | Phase 2 migration. |

Module score: 3.0 / 5

### Data Health

| Area | Score | Finding | Build action |
|---|---:|---|---|
| Data model ownership | 4 | Clear governance DTO. | Split later only if needed. |
| Workflow completeness | 4 | Good queues and drill-downs. | Keep compact queue model. |
| Source of truth | 4 | Best current source for structure/vacancy count. | Extract reusable workforce summary. |
| Cross-module linkage | 4 | Links employees, access, vacancies, sales, salary flags. | Use as reference for source-of-truth extraction. |
| UI/API/service separation | 4 | Service computes, UI renders. | Keep. |
| Test coverage | 3 | Related tests exist for classification and organogram, not full data-health DTO. | Add direct data-health summary test. |
| Production readiness | 4 | Strong build-state module. | Minor consolidation. |

Module score: 3.9 / 5

### Monitoring

| Area | Score | Finding | Build action |
|---|---:|---|---|
| Data model ownership | 4 | Auth/notification/audit monitoring data is clear. | Keep separate from business metrics. |
| Workflow completeness | 4 | Monitoring lists and exports exist. | No build blocker. |
| Source of truth | 4 | Operational monitoring has a dedicated service. | Keep isolated. |
| Cross-module linkage | 3 | Linked to notifications/audit, but not business workflows. | Acceptable for this phase. |
| UI/API/service separation | 4 | Good service/page split. | Keep. |
| Test coverage | 2 | Limited direct monitoring tests. | Add later when ops hardening starts. |
| Production readiness | 4 | Good enough for build phase. | Defer deeper ops work. |

Module score: 3.6 / 5

### Audit Logs

| Area | Score | Finding | Build action |
|---|---:|---|---|
| Data model ownership | 4 | Global audit service exists. | Keep. |
| Workflow completeness | 3 | Reads/writes exist, but not every workflow uses it consistently. | Add standard mutation audit contract later. |
| Source of truth | 4 | `src/lib/admin/audit.ts` is clear. | Keep. |
| Cross-module linkage | 3 | Some modules also use domain-specific audit logs. | Define when global audit is required. |
| UI/API/service separation | 4 | Good separation. | Keep. |
| Test coverage | 2 | Limited direct audit behavior tests. | Add later. |
| Production readiness | 3 | Usable, but consistency work remains. | P2. |

Module score: 3.3 / 5

### Employees

| Area | Score | Finding | Build action |
|---|---:|---|---|
| Data model ownership | 4 | Employee directory owns core employee DTOs. | Keep as employee source. |
| Workflow completeness | 4 | Create/update/import/resignation launch exist. | Continue stabilizing import edge cases. |
| Source of truth | 3 | Directory summary says total employees but returns active employee count. | Extract workforce metrics and clarify naming. |
| Cross-module linkage | 5 | Root dependency for most modules. | Treat changes as high impact. |
| UI/API/service separation | 3 | Strong service, but component is large and contains workflow complexity. | Avoid adding more logic to component. |
| Test coverage | 2 | Workforce classification is tested, but employee directory summary behavior needs direct tests. | Add employee/workforce metric tests. |
| Production readiness | 3 | Operational, but too central to leave ambiguous. | P0 workforce source-of-truth work. |

Module score: 3.4 / 5

### Organogram

| Area | Score | Finding | Build action |
|---|---:|---|---|
| Data model ownership | 4 | Uses vacancy report data with employee/vacancy rows. | Move shared structure totals to workforce metrics. |
| Workflow completeness | 4 | Report view is functional. | Keep. |
| Source of truth | 3 | Uses vacancy report service rather than dedicated workforce structure service. | Reuse `getWorkforceStructureSummary()`. |
| Cross-module linkage | 4 | Correctly links employees and vacancies. | Keep linkage. |
| UI/API/service separation | 4 | Service provides report data. | Keep. |
| Test coverage | 4 | Organogram hardening tests exist. | Add source-of-truth regression after extraction. |
| Production readiness | 4 | Good with minor consolidation. | Phase 1. |

Module score: 3.9 / 5

### Vacancies Report

| Area | Score | Finding | Build action |
|---|---:|---|---|
| Data model ownership | 4 | Vacancy report service owns report DTO. | Keep. |
| Workflow completeness | 4 | Filtering/export/report flow exists. | Keep. |
| Source of truth | 3 | Vacancy definition appears in reports, offers, admin health. | Centralize open vacancy query. |
| Cross-module linkage | 4 | Linked to resignations/offers/organogram/sales. | Keep. |
| UI/API/service separation | 4 | Good service and API route. | Keep. |
| Test coverage | 4 | Organogram/vacancy-related tests exist. | Add open-vacancy summary test. |
| Production readiness | 4 | Strong after source-of-truth extraction. | Phase 1. |

Module score: 3.9 / 5

### CV Database

| Area | Score | Finding | Build action |
|---|---:|---|---|
| Data model ownership | 3 | CV parsing/template logic exists, but domain service boundary is less clear. | Consider `src/lib/cv/service.ts` if this grows. |
| Workflow completeness | 3 | Candidate template/report flow exists. | Define if this is only a template or a full workflow. |
| Source of truth | 2 | Candidate status and pipeline ownership are unclear. | Add candidate service if pipeline is strategic. |
| Cross-module linkage | 2 | Permission links to vacancies, but workflow link to offers is weak. | Link candidate status to offer lifecycle later. |
| UI/API/service separation | 3 | Some logic is in component/API. | Move reusable parsing/summary rules to service. |
| Test coverage | 4 | CV parsing tests exist. | Keep. |
| Production readiness | 3 | Usable for current template/report need. | P2 unless candidate pipeline becomes priority. |

Module score: 2.9 / 5

### Offer Lifecycle

| Area | Score | Finding | Build action |
|---|---:|---|---|
| Data model ownership | 4 | Offer service owns statuses, dashboard, decisions, approval. | Keep. |
| Workflow completeness | 5 | Create, send, accept/reject, approve, close vacancy, create employee. | Add more end-to-end tests. |
| Source of truth | 4 | Strong service owner. | Extract offer metrics only for dashboards. |
| Cross-module linkage | 5 | Correctly links offers, vacancies, employees, notifications. | Protect with regression tests. |
| UI/API/service separation | 4 | Good service/API shape. | Keep. |
| Test coverage | 3 | Some lifecycle behavior tested indirectly; more approval/vacancy tests needed. | Add offer-to-workforce tests. |
| Production readiness | 4 | Strong build module. | Phase 4 metrics/tests. |

Module score: 4.1 / 5

### Hiring Documents

| Area | Score | Finding | Build action |
|---|---:|---|---|
| Data model ownership | 4 | Good service and typed dashboard. | Keep. |
| Workflow completeness | 4 | Definitions, statuses, notes exist. | Link to onboarding. |
| Source of truth | 4 | Service owns logic. | Keep. |
| Cross-module linkage | 3 | Depends on employees, but offer/onboarding linkage is not explicit. | Connect to offer approval/new hire flow if required. |
| UI/API/service separation | 4 | Good. | Keep. |
| Test coverage | 2 | Limited module-specific tests. | Add basic status/definition tests. |
| Production readiness | 4 | Usable. | P2 linkage. |

Module score: 3.6 / 5

### Probation

| Area | Score | Finding | Build action |
|---|---:|---|---|
| Data model ownership | 4 | Dedicated probation service/types. | Keep. |
| Workflow completeness | 5 | Evaluations, reminders, workflow actions, exports. | Keep. |
| Source of truth | 4 | Good owner. | Extract risk metrics for dashboards. |
| Cross-module linkage | 4 | Links employees and notifications. | Add lifecycle effect tests. |
| UI/API/service separation | 4 | Good. | Keep. |
| Test coverage | 4 | Probation stabilization tests exist. | Add metric tests later. |
| Production readiness | 4 | Strong. | Phase 4 metrics. |

Module score: 4.1 / 5

### Contract Renewal

| Area | Score | Finding | Build action |
|---|---:|---|---|
| Data model ownership | 4 | Dedicated contracts service/types. | Keep. |
| Workflow completeness | 5 | Create, renew/not renew/cancel workflow and reminders. | Keep. |
| Source of truth | 4 | Good owner. | Extract risk metrics for dashboards. |
| Cross-module linkage | 4 | Links employees and notifications. | Keep. |
| UI/API/service separation | 4 | Good. | Keep. |
| Test coverage | 4 | Contract hardening tests exist. | Add dashboard risk metric test. |
| Production readiness | 4 | Strong. | Phase 4 metrics. |

Module score: 4.1 / 5

### Resignations

| Area | Score | Finding | Build action |
|---|---:|---|---|
| Data model ownership | 5 | Dedicated resignation service and DB/RPC linkage. | Keep. |
| Workflow completeness | 5 | Creates resignation, opens vacancy, updates employee/access ownership. | Keep. |
| Source of truth | 4 | Strong owner. | Reuse workforce metrics for vacancy effects. |
| Cross-module linkage | 5 | Critical link to employees, vacancies, access, payroll candidates, notifications. | Add more integration tests. |
| UI/API/service separation | 4 | Good. | Keep. |
| Test coverage | 3 | Stabilization tests exist, but end-to-end vacancy/access effects need more coverage. | Add lifecycle-to-workforce tests. |
| Production readiness | 4 | Strong but high impact. | Phase 4 tests. |

Module score: 4.3 / 5

### Fingerprint Report

| Area | Score | Finding | Build action |
|---|---:|---|---|
| Data model ownership | 4 | Attendance report service combines punches, employees, policies. | Keep. |
| Workflow completeness | 4 | Report and export flow exist. | Keep. |
| Source of truth | 4 | Service owns report logic. | Keep. |
| Cross-module linkage | 4 | Links employees, policies, device mapping. | Keep. |
| UI/API/service separation | 4 | Good. | Keep. |
| Test coverage | 2 | Limited direct attendance report tests. | Add report calculation tests. |
| Production readiness | 4 | Good for build phase. | P2 tests. |

Module score: 3.7 / 5

### Device User Mapping

| Area | Score | Finding | Build action |
|---|---:|---|---|
| Data model ownership | 4 | Dedicated mapping service/template. | Keep. |
| Workflow completeness | 4 | Dashboard, save, import/template exist. | Keep. |
| Source of truth | 4 | Clear service. | Keep. |
| Cross-module linkage | 4 | Links raw punches to employees. | Keep. |
| UI/API/service separation | 4 | Good. | Keep. |
| Test coverage | 2 | Limited direct tests. | Add import/mapping tests. |
| Production readiness | 4 | Good. | P2 tests. |

Module score: 3.7 / 5

### Attendance Policies

| Area | Score | Finding | Build action |
|---|---:|---|---|
| Data model ownership | 4 | Dedicated policy service/types. | Keep. |
| Workflow completeness | 4 | Dashboard and save flow exist. | Keep. |
| Source of truth | 4 | Policy service owns rules. | Keep. |
| Cross-module linkage | 4 | Used by fingerprint report. | Keep. |
| UI/API/service separation | 4 | Good. | Keep. |
| Test coverage | 2 | Limited direct tests. | Add policy selection tests. |
| Production readiness | 4 | Good. | P2 tests. |

Module score: 3.7 / 5

### HR Calendar

| Area | Score | Finding | Build action |
|---|---:|---|---|
| Data model ownership | 3 | Uses employee rows directly. | Add calendar service. |
| Workflow completeness | 3 | Calendar display exists. | Define event types. |
| Source of truth | 2 | Event logic is not centralized. | Create `src/lib/hr-calendar/service.ts`. |
| Cross-module linkage | 3 | Employee dates are linked; contract/probation linkage is indirect. | Add explicit event sources. |
| UI/API/service separation | 2 | Page/component own too much. | Move event building to service. |
| Test coverage | 1 | No obvious direct tests. | Add calendar event tests. |
| Production readiness | 2 | Works, but not production-shaped yet. | P2. |

Module score: 2.3 / 5

### Monthly Sales

| Area | Score | Finding | Build action |
|---|---:|---|---|
| Data model ownership | 4 | Sales batches/records service is clear. | Keep. |
| Workflow completeness | 5 | Upload, validate, approve, reject, replace, delete. | Keep. |
| Source of truth | 4 | Import workflow/service own logic. | Keep. |
| Cross-module linkage | 5 | Links employee directory, vacancies, ownership classification. | Protect with tests. |
| UI/API/service separation | 4 | Good. | Keep. |
| Test coverage | 3 | Period/role/others tests exist; import workflow can use more tests. | Add batch state tests. |
| Production readiness | 4 | Strong. | P1/P2 tests. |

Module score: 4.1 / 5

### Sales Dashboard

| Area | Score | Finding | Build action |
|---|---:|---|---|
| Data model ownership | 4 | Sales service returns approved dashboard data. | Keep. |
| Workflow completeness | 4 | Dashboard is functional. | Keep. |
| Source of truth | 3 | KPI/chart calculations also exist in components. | Move reusable metrics to service. |
| Cross-module linkage | 4 | Links employees, vacancies, sales imports. | Keep. |
| UI/API/service separation | 3 | UI contains business calculations. | Extract `sales-metrics.ts`. |
| Test coverage | 3 | Sales logic tests exist, but dashboard DTO tests need expansion. | Add sales metrics tests. |
| Production readiness | 3 | Usable, but drift risk exists. | P1. |

Module score: 3.4 / 5

### Field Coaching

| Area | Score | Finding | Build action |
|---|---:|---|---|
| Data model ownership | 4 | Dedicated coaching service/types. | Keep. |
| Workflow completeness | 5 | Create, submit, review, acknowledge, export. | Keep. |
| Source of truth | 4 | Service owns workflow; scoring helper owns scoring. | Keep. |
| Cross-module linkage | 4 | Links employees and notifications. | Keep. |
| UI/API/service separation | 4 | Good. | Keep. |
| Test coverage | 5 | Strong scoring, analytics, permissions, export, notification tests. | Maintain. |
| Production readiness | 4 | Strong. | Low immediate priority. |

Module score: 4.3 / 5

### Coaching Analytics

| Area | Score | Finding | Build action |
|---|---:|---|---|
| Data model ownership | 4 | Uses coaching reports and analytics helper. | Keep. |
| Workflow completeness | 4 | Filters and analytics exist. | Keep. |
| Source of truth | 4 | Analytics rules are centralized. | Keep. |
| Cross-module linkage | 4 | Links employees and coaching. | Keep. |
| UI/API/service separation | 4 | Good. | Keep. |
| Test coverage | 5 | Analytics tests exist. | Maintain. |
| Production readiness | 4 | Strong. | Low immediate priority. |

Module score: 4.1 / 5

### Payroll Report

| Area | Score | Finding | Build action |
|---|---:|---|---|
| Data model ownership | 5 | Payroll service/types are strong. | Keep. |
| Workflow completeness | 5 | Upload, validate, create, replace, workflow, export, payslips. | Keep. |
| Source of truth | 4 | Payroll service owns core logic. | Extract metrics wrapper for dashboards. |
| Cross-module linkage | 4 | Links employees, expenses, resignations, notifications. | Keep. |
| UI/API/service separation | 4 | Strong service but dashboard component is large. | Avoid adding more logic to UI. |
| Test coverage | 5 | Payroll mapping/workflow/engine tests exist. | Maintain. |
| Production readiness | 4 | Strong. | P1 metrics extraction. |

Module score: 4.4 / 5

### Payslips Center

| Area | Score | Finding | Build action |
|---|---:|---|---|
| Data model ownership | 4 | Payslip search service exists. | Keep. |
| Workflow completeness | 4 | Search/download-centered flow exists. | Keep. |
| Source of truth | 4 | Uses salary records/batches. | Keep. |
| Cross-module linkage | 4 | Links payroll, employee search, access scope. | Keep. |
| UI/API/service separation | 4 | Good. | Keep. |
| Test coverage | 3 | Employee portal payslip tests exist; center-specific tests limited. | Add center search test later. |
| Production readiness | 4 | Good. | Low priority. |

Module score: 3.9 / 5

### Expenses

| Area | Score | Finding | Build action |
|---|---:|---|---|
| Data model ownership | 4 | Expense service exists. | Keep. |
| Workflow completeness | 4 | List, approve, import to payroll, delete/clear reports. | Keep. |
| Source of truth | 4 | `expense-metrics.ts` now owns reusable expense totals, grouping, HR import totals, and DSM summary metrics. | Keep dashboard-specific visual shaping lean. |
| Cross-module linkage | 4 | Links payroll, employees, outstation, platform metrics, overview, and employee portal expense views. | Keep. |
| UI/API/service separation | 4 | Dashboard page now loads through a service DTO; component uses shared metrics helpers for totals/groups. | Keep reducing component-only analytics. |
| Test coverage | 3 | Expense metrics regression covers totals, grouping, import totals, platform, overview, dashboard, and portal wiring. | Add approval/import integration tests later. |
| Production readiness | 4 | Source-of-truth drift is reduced for current expense surfaces. | Monitor real payroll import edge cases. |

Module score: 4.1 / 5

### Expenses Dashboard

| Area | Score | Finding | Build action |
|---|---:|---|---|
| Data model ownership | 4 | Page loads `getPayrollExpenseDashboardData`; employee/report/expense DTO is service-owned. | Keep. |
| Workflow completeness | 4 | Dashboard exists and now shares totals/groups with payroll/platform logic. | Add drilldowns later if needed. |
| Source of truth | 4 | Reusable totals and groups come from `expense-metrics.ts`. | Keep UI-only filters local. |
| Cross-module linkage | 4 | Links employees, payroll expenses, platform metrics, overview, and employee portal summaries. | Keep. |
| UI/API/service separation | 4 | Page is thin; component renders and filters using shared metric helpers. | Keep. |
| Test coverage | 3 | Static and pure regression coverage prevents dashboard source drift. | Add browser smoke later. |
| Production readiness | 4 | Service boundary is now strong enough for current production use. | Add deeper import approval tests later. |

Module score: 4.0 / 5

### Outstation Requests

| Area | Score | Finding | Build action |
|---|---:|---|---|
| Data model ownership | 5 | Outstation service/types are clear. | Keep. |
| Workflow completeness | 5 | Capture, calculate, submit, sync, review, evidence. | Keep. |
| Source of truth | 4 | Service owns calculation and request data. | Keep. |
| Cross-module linkage | 4 | Links employees, maps, expenses. | Keep. |
| UI/API/service separation | 4 | Good. | Keep. |
| Test coverage | 4 | Policy and car evidence tests exist. | Add request workflow tests later. |
| Production readiness | 4 | Strong. | Low immediate priority. |

Module score: 4.3 / 5

### Outstation Policy

| Area | Score | Finding | Build action |
|---|---:|---|---|
| Data model ownership | 5 | Policy rules are in outstation service/types. | Keep. |
| Workflow completeness | 4 | Policy read/update exists. | Keep. |
| Source of truth | 4 | Good. | Keep. |
| Cross-module linkage | 4 | Feeds calculation and request recommendation. | Keep. |
| UI/API/service separation | 4 | Good. | Keep. |
| Test coverage | 4 | Policy classification tests exist. | Maintain. |
| Production readiness | 4 | Strong. | Low immediate priority. |

Module score: 4.1 / 5

### Outstation Heatmaps

| Area | Score | Finding | Build action |
|---|---:|---|---|
| Data model ownership | 4 | Heatmap DTO comes from outstation service. | Keep. |
| Workflow completeness | 4 | Aggregated visual view exists. | Keep. |
| Source of truth | 4 | Uses request service. | Keep. |
| Cross-module linkage | 4 | Links submitted requests and employees. | Keep. |
| UI/API/service separation | 4 | Good. | Keep. |
| Test coverage | 2 | Limited direct heatmap tests. | Add later if heatmap becomes critical. |
| Production readiness | 4 | Good. | Low priority. |

Module score: 3.7 / 5

### Vacation Request

| Area | Score | Finding | Build action |
|---|---:|---|---|
| Data model ownership | 4 | Vacation service/types/calculations exist. | Keep. |
| Workflow completeness | 4 | Request, balance, manager decision, notifications. | Keep. |
| Source of truth | 4 | Calculation helper owns balance rules. | Keep. |
| Cross-module linkage | 4 | Links employees and notifications. | Keep. |
| UI/API/service separation | 4 | Good. | Keep. |
| Test coverage | 5 | Vacation calculation and module tests exist. | Maintain. |
| Production readiness | 4 | Strong. | Low immediate priority. |

Module score: 4.1 / 5

### Vacation Report

| Area | Score | Finding | Build action |
|---|---:|---|---|
| Data model ownership | 4 | Vacation report data comes from service. | Keep. |
| Workflow completeness | 4 | Filters/report exist. | Keep. |
| Source of truth | 4 | Service owns. | Keep. |
| Cross-module linkage | 4 | Links employees and leave requests. | Keep. |
| UI/API/service separation | 4 | Good. | Keep. |
| Test coverage | 5 | Vacation tests cover core rules. | Maintain. |
| Production readiness | 4 | Strong. | Low immediate priority. |

Module score: 4.1 / 5

### Users & Access

| Area | Score | Finding | Build action |
|---|---:|---|---|
| Data model ownership | 4 | Access-control and permission services exist. | Keep. |
| Workflow completeness | 4 | User status, upsert, overrides, setup links. | Keep. |
| Source of truth | 4 | Good central owner. | Keep. |
| Cross-module linkage | 5 | Linked to employees, auth, audit, permissions. | Treat changes carefully. |
| UI/API/service separation | 4 | Good. | Keep. |
| Test coverage | 3 | Access governance tests exist. | Add workflow DTO tests later. |
| Production readiness | 4 | Strong enough for build phase. | Not current focus. |

Module score: 4.0 / 5

### Email Composer

| Area | Score | Finding | Build action |
|---|---:|---|---|
| Data model ownership | 3 | Route/email helper driven. | Add clearer composer service if it grows. |
| Workflow completeness | 3 | Sending flow exists. | Define draft/send/history expectations. |
| Source of truth | 3 | Shared email sender exists, composer rules less centralized. | Add `src/lib/email/composer.ts` if needed. |
| Cross-module linkage | 3 | Links templates and email sending. | Keep simple. |
| UI/API/service separation | 3 | Route owns meaningful logic. | Move reusable validation later. |
| Test coverage | 3 | HR reply template test exists. | Add send payload test if needed. |
| Production readiness | 3 | Usable, not a core build blocker. | P2. |

Module score: 3.0 / 5

### Email Templates

| Area | Score | Finding | Build action |
|---|---:|---|---|
| Data model ownership | 4 | Template and recipient rule service exists. | Keep. |
| Workflow completeness | 4 | List, preview, update, test templates. | Keep. |
| Source of truth | 4 | Good service. | Keep. |
| Cross-module linkage | 4 | Feeds notifications and roles/employees. | Keep. |
| UI/API/service separation | 4 | Good. | Keep. |
| Test coverage | 3 | Email notification tests exist; template editor tests limited. | Add template validation tests. |
| Production readiness | 4 | Good. | Low priority. |

Module score: 3.9 / 5

## Ranked Work Queue

### Start Now

1. Platform metrics aggregator for Command Center and Overview.
2. Expense dashboard service boundary.
3. Sales dashboard metric extraction.
4. HR Calendar service boundary.

### Next

5. Lifecycle-to-workforce tests for remaining edge cases.
6. Contract/probation risk metric extraction.
7. CV/candidate service boundary.

### Later

8. Accepted-offer RPC database-level transaction review.
9. Email composer service boundary.
10. Standard audit contract for high-risk workflow mutations.

## Phase 1 Completion Update

Completed scope:

- Workforce Lifecycle + Sales Seat Continuity.
- Manual employee add already closed matching vacancies.
- Bulk employee upload now closes matching vacancies for new hires.
- Accepted offer approval now defensively closes the matching vacancy after the hire RPC.
- Resignation, termination, and probation termination remain routed through the vacancy-opening lifecycle path.
- Command Center and Data Health now use the same structure formula helper.
- Employee portal sales can include seat-continuity records for replacement hires.

Updated scores:

| Module | Before | After | Reason |
|---|---:|---:|---|
| Command Center | 3.0 | 4.0 | Uses Data Health stats and shared structure formula fallback. |
| Data Health | 3.9 | 4.2 | Structure total calculation now uses shared helper. |
| Employees | 3.4 | 4.2 | Manual add plus bulk import now follow vacancy close behavior. |
| Organogram | 3.9 | 4.3 | Seat continuity is better protected through vacancy open/close tests. |
| Vacancies Report | 3.9 | 4.4 | Vacancy lifecycle is now protected across hire and exit sources. |
| Offer Lifecycle | 4.1 | 4.4 | Accepted offer approval now closes/fills the matching vacancy defensively. |
| Probation | 4.1 | 4.3 | Termination path remains unified through resignation/vacancy workflow and is regression-checked. |
| Sales Dashboard / Portal Sales | 3.4 | 3.8 | Replacement seat sales continuity helper and portal fetch path added. |

Remaining Phase 1 gaps:

1. Database RPC behavior still needs live verification in Supabase for `phx_approve_accepted_offer` and `phx_resign_employee_and_open_vacancy`.
2. Sales continuity now exists in the portal fetch path, but admin Sales Dashboard still needs metric extraction and service-level cleanup.
3. Overview still has duplicated cross-domain aggregation and should move to the platform metrics phase.

## Phase 2 Completion Update

Completed scope:

- Added `src/lib/platform/metrics.ts` as the shared source for platform KPIs.
- Command Center now returns KPI totals from platform metrics first.
- Overview now reads reusable KPI totals from platform metrics instead of owning those totals locally.
- Workforce, sales, payroll, expenses, recruitment, and lifecycle risk totals now have one shared platform source.
- Added `tests/platform-metrics.test.ts` to prevent Command Center and Overview drifting away from the shared source.

Updated scores:

| Module | Before | After | Reason |
|---|---:|---:|---|
| Command Center | 4.0 | 4.4 | Returns top-level KPIs from platform metrics. |
| Data Health | 4.2 | 4.3 | Structure totals remain shared with workforce lifecycle helper and feed Command Center health. |
| Monitoring | 3.6 | 3.8 | Benefits from shared admin/service data health and platform structure direction; still needs event-specific metrics extraction. |
| Audit Logs | 3.3 | 3.4 | No major logic change; remains a supporting source for activity, not yet a full platform metric owner. |
| Overview | 3.0 | 4.0 | Reusable KPI totals now come from platform metrics while visual distributions remain local. |
| Sales Dashboard / Portal Sales | 3.8 | 3.9 | Sales totals now flow through platform metrics for Overview/Command Center. |
| Payroll Report | 4.4 | 4.5 | Payroll summary is reused by platform metrics. |
| Expenses Dashboard | 2.3 | 2.7 | Expense totals are now centralized for platform KPIs, but dashboard service boundary is still weak. |

Remaining Phase 2 gaps:

1. Command Center still contains legacy fallback helper functions for resilience; the primary return path now uses platform metrics.
2. Overview still owns chart/distribution shaping. That is acceptable for visual-only data, but not for reusable KPI totals.
3. Monitoring needs a later dedicated operational metrics service if we want event counts, incidents, and freshness metrics centralized.
4. Audit Logs remain a source table/service, not a platform KPI layer yet.

## Phase 3 Completion Update

Completed scope:

- Added `src/lib/payroll/expense-metrics.ts` as the shared source for reusable expense totals, groups, trends, approved payroll import totals, and DSM team summaries.
- Added `getPayrollExpenseMetrics` and `getPayrollExpenseDashboardData` to the payroll expenses service.
- Platform Metrics now consumes payroll expense metrics instead of loading and calculating expense rows directly.
- Overview now consumes the payroll expense dashboard DTO for expense visual data and platform metrics for reusable KPI totals.
- Expenses Dashboard page no longer loads employee directory or expense rows directly; it uses the service DTO.
- Expenses Dashboard component now uses shared metric helpers for totals and grouped comparisons.
- Employee portal personal and NSM team expense summaries now use shared expense summaries/DSM aggregators.
- Payroll approved-expense totals now use the same `getApprovedExpenseTotalsByHrId` helper used by the metric layer.
- Added `tests/expense-metrics.test.ts` to prove calculations and module wiring do not drift.

Updated scores:

| Module | Before | After | Reason |
|---|---:|---:|---|
| Expenses | 3.3 | 4.1 | Reusable totals/import totals/team summaries are centralized in the expense metric boundary. |
| Expenses Dashboard | 2.7 | 4.0 | Page/component no longer own reusable business KPIs directly. |
| Platform Metrics | 4.4 | 4.5 | Expense totals now come from the payroll expense source instead of direct row aggregation. |
| Overview | 4.0 | 4.1 | Expense trend/breakdown now comes from the shared expense dashboard DTO. |
| Payroll Report | 4.5 | 4.6 | Approved expense totals for payroll use the shared metric helper. |
| Employee Portal Expenses | 3.8 | 4.0 | Personal and NSM team expense totals now reuse shared metric helpers. |

Remaining Phase 3 gaps:

1. The actual database payroll import still runs through `phx_import_approved_expenses_to_payroll`; application-side totals now share helpers, but the SQL function should be audited in a later database phase.
2. Expense dashboard browser-level smoke coverage is still missing.
3. Outstation request approval can still mature into a fuller expense lifecycle workflow if we want live outstation requests to become payroll expenses automatically.
4. Some employee portal expense chart/trend shaping remains local because it is view-specific, not a reusable KPI source.

## Phase 4 Completion Update

Completed scope:

- Added `src/lib/operations/events.ts` as the shared source for operational monitoring, audit-log reads, and recent workflow activity.
- Monitoring page and monitoring CSV export now consume `getOperationalMonitoringStats`.
- Monitoring dashboard now renders shared operational workflow events, failure counts, and latest activity.
- Audit Logs still use the audit service API, but the read path now delegates to `getOperationalAuditLogs`.
- Overview activity feed now consumes `getOperationalRecentActivity` instead of querying payroll/sales/offer activity tables directly.
- Command Center data now includes the same operational activity summary for command-level reuse.
- Added `tests/operational-events.test.ts` to prevent Monitoring, Audit Logs, Overview, and Command Center drifting away from the shared operational source.

Updated scores:

| Module | Before | After | Reason |
|---|---:|---:|---|
| Monitoring | 3.8 | 4.4 | Operational health KPIs and workflow activity now come from a shared service and render in Monitoring. |
| Audit Logs | 3.4 | 4.0 | Audit log reads now route through the operational events source while writes remain in the audit service. |
| Overview | 4.1 | 4.2 | Recent activity no longer owns payroll/sales/offer activity queries locally. |
| Command Center | 4.4 | 4.5 | Command data now includes shared operational activity summary. |
| Platform Metrics | 4.5 | 4.5 | No business KPI change; operational metrics intentionally remain separate. |

Remaining Phase 4 gaps:

1. Domain workflows still vary in whether they write global `audit_logs` in addition to domain audit tables.
2. Monitoring browser smoke coverage is still missing.
3. Operational freshness currently covers recent workflow activity, not a full SLA/freshness policy per integration.
4. Security/RLS/auth hardening remains intentionally out of scope for this phase.

## Phase 5 Completion Update

Completed scope:

- Added `src/lib/sales/metrics.ts` as the shared source for sales achievement math, current approved batch selection, dashboard view metrics, product analytics, and portal-scoped sales metrics.
- Sales Dashboard now consumes shared dashboard view metrics instead of recalculating reusable KPI totals locally.
- Employee Portal sales dashboard now consumes shared portal sales metric construction while keeping seat-continuity record discovery in the portal service.
- Platform Metrics now consumes `getSalesPlatformMetrics`, so Command Center, Overview, and Platform Metrics share the same sales KPI DTO.
- Command Center legacy fallback no longer owns local sales replacement/approved-batch aggregation.
- Sales dashboard current-record selection now excludes draft/validated/rejected/replaced batches and only includes current approved, non-replaced sales records.
- Added `tests/sales-source-of-truth.test.ts` to protect approved/replaced/rejected batch selection, dashboard metrics, portal sales metrics, platform wiring, command-center wiring, and dashboard component wiring.

Updated scores:

| Module | Before | After | Reason |
|---|---:|---:|---|
| Monthly Sales | 4.1 | 4.4 | Approved/replaced/rejected batch selection is now reusable and regression-tested. |
| Sales Dashboard | 3.4 | 4.2 | Reusable KPI/view calculations moved out of the dashboard component into the sales metric boundary. |
| Employee Portal Sales | 4.0 | 4.3 | Portal scoped totals now share the sales metric builder while preserving seat continuity. |
| Platform Metrics | 4.5 | 4.6 | Sales KPI mapping now consumes a domain sales metrics DTO. |
| Overview | 4.2 | 4.3 | Sales totals continue through platform metrics and agree with the domain source. |
| Command Center | 4.5 | 4.6 | Sales fallback path no longer duplicates batch aggregation logic. |

Remaining Phase 5 gaps:

1. Employee portal service still contains older local sales-dashboard builder code that is no longer used; it can be removed in a cleanup pass.
2. Sales import workflow still relies on database table updates instead of a transaction/RPC for approve/replace/delete.
3. Browser-level smoke coverage for dashboard filters and portal sales views is still missing.
4. Security/RLS/auth hardening remains intentionally out of scope for this phase.

## Phase 6 Completion Update

Completed scope:

- Added `src/lib/recruitment/onboarding-metrics.ts` as the shared source for offer lifecycle metrics, accepted-to-employee conversion, vacancy linkage, hiring-document readiness, and CV candidate pipeline summaries.
- Offer Lifecycle now builds its dashboard summary through `summarizeOfferLifecycleRows`.
- Hiring Documents now builds onboarding readiness through `summarizeHiringDocumentReadiness`.
- Platform Metrics now builds recruitment totals through `buildRecruitmentOnboardingMetrics` and includes hiring-document readiness signals.
- Command Center legacy recruitment fallback now uses the shared recruitment metric helper instead of local status counting.
- Accepted-offer approval still uses `phx_approve_accepted_offer` and defensively closes the matching vacancy through the existing workforce lifecycle path.
- Added `tests/recruitment-onboarding-metrics.test.ts` to protect offer metrics, hiring-document readiness, candidate pipeline summary, platform wiring, overview wiring, command-center wiring, and accepted-offer workforce linkage.

Updated scores:

| Module | Before | After | Reason |
|---|---:|---:|---|
| CV Database | 3.0 | 3.2 | Candidate status summary now has a reusable metric helper, though CV remains a local workbook workflow. |
| Offer Lifecycle | 4.4 | 4.6 | Dashboard metrics now use shared recruitment metrics while preserving accepted-offer employee/vacancy linkage. |
| Hiring Documents | 3.8 | 4.2 | Onboarding document readiness is now centralized and reusable. |
| Platform Metrics | 4.6 | 4.7 | Recruitment totals now include onboarding readiness and conversion signals from the shared source. |
| Overview | 4.3 | 4.4 | Recruitment KPIs continue to flow from platform metrics. |
| Command Center | 4.6 | 4.7 | Recruitment fallback no longer duplicates offer status counting logic. |

Remaining Phase 6 gaps:

1. CV Database is still a local workbook parser, not a persisted candidate pipeline linked to offers.
2. Accepted-offer approval still depends on `phx_approve_accepted_offer`; the SQL function should be audited in a database transaction phase.
3. Hiring-document readiness is linked to employee onboarding, but document auto-initialization at accepted-offer approval is not implemented yet.
4. Browser-level smoke coverage for Offer Lifecycle and Hiring Documents is still missing.
5. Security/RLS/auth hardening remains intentionally out of scope for this phase.

## Phase 7 Completion Update

Completed scope:

- Added `src/lib/attendance/metrics.ts` as the shared source for attendance status classification, device-user mapping health, policy selection, policy summaries, fingerprint summaries, and attendance readiness metrics.
- Fingerprint Report now uses shared policy selection, punch status classification, and summary totals instead of local reusable KPI logic.
- Device User Mapping now uses shared device key, HR_ID normalization, status classification, and mapping summary totals.
- Attendance Policies now uses the shared policy summary helper.
- Added `src/lib/hr-calendar/calendar-logic.ts` and `src/lib/hr-calendar/service.ts` so HR Calendar event construction, working-day checks, holiday exclusion, and employee calendar loading have clear owners.
- HR Calendar page now loads through `getHrCalendarData`; the component now consumes reusable calendar event/day builders.
- Platform Metrics now includes attendance readiness and current-month working-day signals from the shared attendance/calendar sources.
- Command Center, Overview, and Data Health now receive attendance readiness/mapping signals from shared sources where applicable.
- Added `tests/attendance-calendar-source.test.ts` to protect attendance classification, device mapping health, policy precedence, HR calendar event/working-day logic, and module wiring.

Updated scores:

| Module | Before | After | Reason |
|---|---:|---:|---|
| Fingerprint Report | 3.7 | 4.2 | Report status, policy selection, and summary totals now use shared attendance logic and direct regression coverage. |
| Device User Mapping | 3.7 | 4.2 | Mapping status/readiness counts now have one reusable source. |
| Attendance Policies | 3.7 | 4.1 | Policy summary and policy precedence are now shared and tested. |
| HR Calendar | 2.3 | 4.0 | Event building, working-day/holiday logic, and page loading moved into reusable calendar boundaries. |
| Platform Metrics | 4.7 | 4.8 | Attendance readiness and working-day signals now flow through the shared platform metrics layer. |
| Overview | 4.4 | 4.5 | Attendance signals are now available from platform metrics, keeping cross-dashboard totals aligned. |
| Command Center | 4.7 | 4.8 | Command data now receives attendance readiness from platform metrics instead of any page-local source. |
| Data Health | 4.3 | 4.4 | Data Health now includes attendance mapping readiness signals through the shared attendance metric helper. |

Remaining Phase 7 gaps:

1. HR Calendar holiday input is reusable in code, but there is no persisted holiday admin table/UI yet.
2. Fingerprint report still reports deductions/readiness; it does not yet mutate payroll deductions.
3. Raw punch ingestion still depends on device mapping quality; unmapped-punch remediation can be expanded later.
4. Browser-level smoke coverage for Attendance and HR Calendar screens is still missing.
5. Security/RLS/auth hardening remains intentionally out of scope for this phase.

## Phase 8 Completion Update

Completed scope:

- Added `src/lib/vacation/metrics.ts` as the shared source for vacation request totals, paid/unpaid day totals, pending/approved/rejected counts, manager decision action counts, and platform leave metrics.
- Vacation duration now reuses HR Calendar working-day logic through `countHrWorkingDays` and `isHrWorkingDay`, including reusable holiday exclusion.
- Vacation Report summary now uses `summarizeVacationRequests` instead of owning reusable KPI calculations in the service.
- Vacation Request preview continues to use the same duration helper as request submission, so request and report day calculations stay aligned.
- Platform Metrics now includes leave totals from `getVacationReportData` and `buildVacationPlatformMetrics`.
- Command Center, Overview, and Data Health now receive leave request signals from shared leave metrics where applicable.
- Added `tests/leave-source-of-truth.test.ts` to protect calendar-aware duration logic, holiday exclusion, vacation summary totals, and Platform/Overview/Command/Data Health wiring.

Updated scores:

| Module | Before | After | Reason |
|---|---:|---:|---|
| Vacation Request | 4.1 | 4.4 | Request preview and submission now use HR Calendar-aware working-day logic. |
| Vacation Report | 4.1 | 4.4 | Report summary totals now come from shared leave metrics. |
| HR Calendar | 4.0 | 4.2 | Working-day and holiday-aware calendar logic now feeds leave calculations. |
| Platform Metrics | 4.8 | 4.9 | Leave request totals now flow through the shared platform metrics layer. |
| Overview | 4.5 | 4.6 | Leave signals are available from platform metrics for dashboard reuse. |
| Command Center | 4.8 | 4.9 | Command data now receives leave totals from platform metrics. |
| Data Health | 4.4 | 4.5 | Data Health now receives leave pending/approved/rejected signals from shared leave metrics. |

Remaining Phase 8 gaps:

1. Holiday exclusion is reusable in code, but holidays are not yet persisted/admin-managed.
2. Leave approval does not yet create payroll deduction/addition rows for unpaid leave.
3. Leave balance policy is still annual/simple; advanced policies such as carryover, public holidays by country, or custom leave types are not implemented.
4. Browser-level smoke coverage for Vacation Request and Vacation Report is still missing.
5. Security/RLS/auth hardening remains intentionally out of scope for this phase.

## Phase 9 Completion Update

Completed scope:

- Added `src/lib/lifecycle-risk/metrics.ts` as the shared source for contract renewal windows, probation windows, probation progress/status, lifecycle journey dates, lifecycle risk alerts, and platform risk totals.
- Platform Metrics now builds lifecycle risk from Contract Renewal rows and Probation rows through `buildLifecycleRiskMetrics`.
- Overview risk alerts now consume `platformMetrics.lifecycleRisk.alerts` instead of rebuilding contract/probation windows locally.
- Command Center primary and fallback risk paths now use Platform Metrics/shared lifecycle risk metrics instead of local date-window logic.
- Contract Renewal screen now uses shared contract renewal row summaries and shared lifecycle date-difference logic.
- Probation screen now uses shared probation status/progress and summary logic.
- Employee Portal contract/probation journey and workforce due counts now use the same lifecycle risk windows.
- Added `tests/lifecycle-risk-source.test.ts` to protect lifecycle date windows, contract/probation summaries, platform/overview/command wiring, and module reuse.

Updated scores:

| Module | Before | After | Reason |
|---|---:|---:|---|
| Contract Renewal | 4.1 | 4.5 | Renewal due windows and request summaries now come from shared lifecycle risk logic. |
| Probation | 4.2 | 4.6 | Probation zones, progress, workflow action counts, and risk windows now share one source. |
| Employee Portal Contract/Probation | 3.8 | 4.3 | Portal lifecycle journey and due counts now reuse the same contract/probation windows. |
| Platform Metrics | 4.9 | 4.9 | Lifecycle risk totals now include alerts and workflow action signals from the shared source. |
| Overview | 4.6 | 4.7 | Risk alerts no longer duplicate date-window calculations. |
| Command Center | 4.9 | 4.9 | Command risk totals now stay aligned with Platform Metrics and lifecycle risk source. |

Remaining Phase 9 gaps:

1. Contract/probation reminders are now window-ready, but reminder scheduling/delivery still depends on the existing notification workflow.
2. Contract renewal and probation decisions continue through existing services; deeper transaction/RPC auditing is deferred.
3. Employee portal views consume lifecycle dates, but there is no dedicated contract/probation employee self-service decision screen yet.
4. Browser-level smoke coverage for Contract Renewal, Probation, and employee portal lifecycle panels is still missing.
5. Security/RLS/auth hardening remains intentionally out of scope for this phase.

## Phase 10 Completion Update

Completed scope:

- Added `src/lib/communication/metrics.ts` as the shared source for email template readiness, notification outbox status totals, notification monitoring totals, in-app notification row mapping, and reusable email recipient parsing/validation.
- Email Notification Center outbox totals now flow through `summarizeNotificationOutboxRows`.
- Monitoring notification metrics now flow through `summarizeNotificationMonitoring` instead of owning local sent/failed/pending calculations.
- Email Templates now exposes shared readiness metrics through `getEmailTemplateReadinessMetrics` and renders readiness/routing signals from the same source.
- Platform Metrics now includes communication/template readiness and notification queue totals through `buildCommunicationMetrics`.
- Employee-visible in-app notifications now use shared row mapping through `mapInAppNotificationRows`.
- Email Composer send validation now uses shared communication email parsing/validation.
- Contract renewal reminder windows now reuse lifecycle risk windows, probation reminder windows reuse lifecycle risk constants, and birthday notifications reuse HR Calendar birthday event logic.
- Added `tests/communication-source-of-truth.test.ts` to protect communication metrics, template readiness, monitoring wiring, in-app mapping, composer validation, platform wiring, and reminder source reuse.

Updated scores:

| Module | Before | After | Reason |
|---|---:|---:|---|
| Email Composer | 3.2 | 4.0 | Recipient parsing/validation now uses shared communication helpers while send workflow remains simple. |
| Email Templates | 3.7 | 4.3 | Template readiness and routing gaps now have a shared metric source and page-level visibility. |
| Email Notification Center | 4.0 | 4.4 | Outbox status totals now share the same communication status summarizer. |
| Monitoring | 4.4 | 4.6 | Notification sent/failed/pending/provider delivery metrics now use the shared communication source. |
| Employee Portal Notifications | 3.8 | 4.2 | In-app notification mapping and probation recipient filtering now use shared communication mapping. |
| Platform Metrics | 4.9 | 4.9 | Communication readiness and queue totals now exist in the platform metrics contract. |

Remaining Phase 10 gaps:

1. Provider send logging still depends on Resend webhook delivery rows; direct composer sends are accepted by provider but do not create a richer business activity record yet.
2. Email template preview/browser smoke coverage is still missing.
3. Notification retry policy is centralized in the existing outbox processor, but advanced SLA/alert escalation is not implemented yet.
4. Users & Access was intentionally not redesigned in this phase; security/RLS/auth hardening remains out of scope.

## Phase 11 Completion Update

Completed scope:

- Audited the sidebar modules after Phases 1-10 for remaining dashboard-owned KPIs, stale fallback logic, workflow linkage gaps, and missing source-of-truth tests.
- Confirmed the active employee access linkage gap was closed before Phase 11: production now has `125/125` active employees linked across `employees`, `app_auth_users`, `user_access_profiles`, and Supabase `auth.users`.
- Removed the unused legacy Monitoring fallback implementation from `src/lib/admin/service.ts`; Monitoring now stays on the shared operational events source without a duplicated local copy.
- Added `buildCoachingReportAnalytics` and `filterCoachingQuarterlySummaryByReports` to `src/lib/coaching/analytics.ts`; the Coaching Analytics API route, admin page, and Training Manager portal page no longer own reusable report summary calculations.
- Added `buildSalesManagerPerformanceGroups` to `src/lib/sales/metrics.ts`; the NSM Medical Reps Performance page no longer groups DSM totals or calculates district achievement locally.
- Added regression coverage for employee access provisioning, coaching analytics route wiring, Monitoring source usage, and employee portal sales manager grouping.

Current module score snapshot:

| Area | Current score | Notes |
|---|---:|---|
| Command Center | 4.9 | Cross-module KPIs flow through Platform Metrics and domain sources. |
| Data Health | 4.6 | Workforce/access/attendance/leave signals are shared; active employee access coverage is now clean. |
| Monitoring | 4.7 | Operational events service is the source; stale local fallback removed. |
| Audit Logs | 4.0 | Reads are shared through operational events; mutation audit consistency remains a later hardening item. |
| People Management | 4.4 | Workforce lifecycle, offer hiring, vacancies, organogram continuity, and access provisioning are linked; CV remains the weakest submodule. |
| Attendance Management | 4.2 | Fingerprint, device mapping, policies, and HR Calendar logic share attendance/calendar sources. |
| Sales & Performance | 4.4 | Sales import/dashboard/portal metrics are shared; coaching analytics summary is now centralized. |
| Payroll Management | 4.6 | Payroll workflow and approved expense totals use shared payroll/expense sources. |
| Expenses & Outstation | 4.1 | Expense KPIs are shared; outstation-to-payroll automation remains future workflow work. |
| Leave Management | 4.4 | Vacation request/report calculations use shared leave and HR Calendar logic. |
| Access & Communication | 4.4 | Template, notification, setup, and employee access provisioning sources are centralized without security redesign. |
| Employee Portal Surfaces | 4.3 | Sales, payroll, expenses, notifications, and lifecycle panels consume shared sources where reusable. |

Updated scores:

| Module | Before | After | Reason |
|---|---:|---:|---|
| Monitoring | 4.6 | 4.7 | Removed duplicated legacy monitoring fallback from the admin service. |
| Coaching Analytics | 4.1 | 4.4 | Reusable report summary and quarterly filtering moved into the coaching analytics source. |
| Employee Portal Sales | 4.3 | 4.4 | NSM medical-rep district grouping now uses the sales metric helper. |
| Users & Access / Employee Linkage | 4.0 | 4.4 | Active employee access provisioning is complete for live data and role-aware for new hires. |
| Full System Workflow Closure | 4.2 | 4.5 | Remaining fixes were small, source-oriented, and regression-tested without introducing a new architecture layer. |

Remaining Phase 11 gaps:

1. Browser smoke coverage is still missing for several high-value screens: Command Center, Data Health, Monitoring, Sales Dashboard, Employee Portal sales, Offer Lifecycle, Hiring Documents, Vacation, Contract Renewal, and Probation.
2. Database RPCs/functions still need a later transaction audit: accepted-offer approval, resignation/open-vacancy, payroll expense import, and sales batch approve/replace/delete.
3. CV Database remains a workbook/parser workflow rather than a persisted candidate pipeline tightly linked to offers.
4. HR Calendar holiday logic is reusable in code, but holidays are not yet persisted/admin-managed.
5. Leave approval does not yet create payroll deduction/addition rows for unpaid leave.
6. Outstation requests do not yet automatically become payroll expenses after approval.
7. Direct Email Composer sends do not yet create a richer business activity record beyond provider/send handling.
8. Security/RLS/auth hardening remains intentionally out of scope for this production-build phase.

## Phase 12 Completion Update

Completed scope:

- Audited database-backed cross-module mutation paths for accepted offer approval, manual/bulk employee creation, resignation/open-vacancy, probation termination, sales import actions, payroll upload/replace/delete/workflow, approved expense import, vacation approval readiness, outstation auditability, and shared audit log consistency.
- Confirmed the highest-risk workforce and payroll import mutations already use existing RPC/service boundaries: `phx_approve_accepted_offer`, `phx_resign_employee_and_open_vacancy`, `phx_create_salary_batch`, `phx_replace_salary_batch`, `phx_delete_salary_batch`, and `phx_import_approved_expenses_to_payroll`.
- Fixed shared audit persistence so `writeRequiredAuditLog` now fails if the `audit_logs` insert fails instead of silently accepting a missing trace.
- Added workflow audit entity types for sales import batches, payroll batches, and vacation requests, and exposed them in the Audit Logs filter.
- Hardened sales import approve/reject/replace/delete to check Supabase update/delete/domain-audit errors and write a shared audit entry after the domain audit record.
- Added required shared audit traces to payroll workflow transitions while preserving the existing optimistic status check.
- Added required shared audit traces to vacation manager decisions while preserving the existing pending-status guard and vacation event log.
- Added regression coverage for transaction-critical RPC usage, service wiring, workflow audit traceability, sales workflow error handling, payroll optimistic transitions, vacation decision auditability, employee access provisioning, probation termination routing, and outstation audit log continuity.

Database transaction readiness scores:

| Workflow | Before | After | Reason |
|---|---:|---:|---|
| Accepted offer approval -> employee/access | 4.4 | 4.5 | Existing offer RPC and access provisioning path verified under Phase 12 regression coverage. |
| Manual/bulk employee creation -> access | 4.4 | 4.5 | Manual and bulk routes are protected by the same new-hire access provisioning test coverage. |
| Resignation/termination -> vacancy | 4.6 | 4.6 | Existing vacancy-opening RPC remains the source; no rewrite needed. |
| Probation termination -> resignation path | 4.3 | 4.5 | Regression coverage now protects the shared termination/vacancy route. |
| Sales import approve/reject/replace/delete | 3.9 | 4.3 | Error handling and shared audit traces added around workflow mutations. |
| Payroll upload/replace/delete | 4.5 | 4.6 | Existing payroll RPCs verified; no app rewrite needed. |
| Payroll workflow approval/lock/reject | 4.2 | 4.5 | Optimistic status guard now has required shared audit traceability. |
| Approved expense import to payroll | 4.4 | 4.5 | Existing approved-expense RPC verified under transaction regression coverage. |
| Vacation approval payroll readiness | 3.9 | 4.2 | Decision workflow now has required shared audit traceability; payroll deduction automation remains future work. |
| Outstation approval payroll readiness | 3.6 | 3.8 | Existing outstation audit continuity verified; automatic payroll conversion remains future work. |
| Audit Logs workflow traceability | 4.0 | 4.4 | Required audit persistence now throws on failed DB insert and workflow entity filters are exposed. |

Remaining Phase 12 gaps:

1. Sales approve/reject/delete/replace is now error-checked and traceable, but it is still app-service multi-step rather than a dedicated database RPC transaction.
2. Vacation approval calculates paid/unpaid readiness and is traceable, but it still does not create payroll deduction/addition rows automatically.
3. Outstation requests remain auditable, but approved outstation-to-expense/payroll automation is not implemented yet.
4. Payroll workflow audit writes occur after the status update; a future DB RPC could make status transition plus audit insertion fully atomic.
5. Browser smoke coverage for workflow screens remains missing.
6. Security/RLS/auth hardening remains intentionally out of scope.

## Phase 13 Completion Update

Completed scope:

- Browser-smoked the critical admin and employee portal workflow surfaces after Phases 1-12 using authenticated development sessions.
- Verified Command Center, Data Health, Monitoring, Audit Logs, Employees, Vacancies, Offers, Hiring Documents, Resignations, Probation, Sales, Sales Queue, Payroll, Payroll Expenses, Expenses Dashboard, Vacation Request, Vacation Report, Outstation Requests, and employee portal sales/payroll/expenses routes render without browser-visible application errors.
- Fixed Data Health workforce structure totals so open vacancies use the same open-vacancy source as Command Center and Platform Metrics. Current smoke values are `151 total structure = 125 active employees + 26 open vacancies`.
- Fixed a server/client rendering gap by moving shared admin shell class tokens out of the client-only admin design system module.
- Fixed employee portal expenses visibility by routing `/employee-portals/expenses` to the existing personal expense dashboard and exposing an Expenses navigation entry in the portal shell.
- Added Phase 13 regression coverage for Data Health open-vacancy filtering, server-safe admin shell tokens, and employee portal expense route/navigation wiring.
- Added a repeatable Phase 13 browser smoke runner at `scripts/phase13-browser-smoke.mjs`.

Production readiness score updates:

| Area | Before | After | Reason |
|---|---:|---:|---|
| Command Center totals | 4.9 | 4.9 | Browser verified shared structure totals render against the shared workforce source. |
| Data Health totals | 4.6 | 4.8 | Vacancy totals now filter to open vacancies and agree with Command Center. |
| Monitoring / Audit Logs rendering | 4.7 / 4.4 | 4.8 / 4.5 | Browser smoke verified operational screens render through the shared event/audit sources. |
| People lifecycle screens | 4.5 | 4.6 | Employee, vacancy, offer, hiring document, resignation, and probation screens render after the workflow wiring phases. |
| Sales / Payroll / Expenses workflow screens | 4.4 / 4.6 / 4.1 | 4.5 / 4.7 / 4.3 | Browser smoke verified the main workflow surfaces and the employee expense route gap was closed. |
| Leave / Outstation readiness screens | 4.4 / 3.8 | 4.5 / 3.9 | Vacation and outstation readiness surfaces render; automation gaps remain future work. |
| Employee Portal visibility | 4.3 | 4.5 | Sales, payroll, and expenses are now browser-verified from the portal session. |
| Browser production smoke coverage | 2.8 | 4.2 | Critical route smoke is now repeatable and regression-backed for gaps found during testing. |

Remaining Phase 13 production gaps:

1. Browser smoke verifies route rendering and visibility, but not full file-upload interaction paths for employee bulk upload, sales import, or payroll upload.
2. Accepted-offer approval, resignation, probation termination, payroll workflow approval, and sales batch actions remain covered by regression/service tests rather than destructive browser mutations against live data.
3. Outstation approval-to-payroll automation and vacation payroll deduction automation remain future production workflow work.
4. Sales batch workflow is still app-service multi-step rather than one database RPC transaction.
5. Security/RLS/auth hardening remains intentionally out of scope.

## Phase 14 Completion Update

Completed scope:

- Added `scripts/phase14-controlled-mutation-smoke.mjs` to exercise controlled mutation paths with authenticated browser sessions and safe fixtures only.
- Verified manual employee add drawer validation and employee bulk upload invalid-file handling without creating records.
- Verified employee import dry-run/confirm missing-file guards.
- Verified accepted-offer approval, resignation vacancy-opening, probation termination, sales import approval, and payroll workflow approval using nonexistent safe fixtures rather than live records.
- Verified sales upload, sales invalid action, payroll upload, payroll replace, approved expense import, vacation request, vacation decision, outstation submit, and outstation admin ID guards.
- Verified Command Center, Data Health, Monitoring, and Audit Logs remained reachable before and after the controlled mutation probes.
- Tightened workflow API error semantics so validation/not-found outcomes return controlled `400`/`404` responses instead of generic `500` responses for manual employee add, accepted-offer approval, employee resignation, and outstation submit.
- Added Phase 14 regression coverage for controlled mutation smoke wiring and API guard status mapping.

Controlled mutation score updates:

| Workflow | Before | After | Reason |
|---|---:|---:|---|
| Manual employee add validation | 4.5 | 4.7 | Browser drawer validation and API validation now return controlled `400` responses. |
| Bulk employee upload guard | 4.5 | 4.6 | Dry-run/confirm missing-file guards and invalid-file UI interaction are now smoke-tested. |
| Accepted-offer approval guard | 4.5 | 4.6 | Nonexistent safe fixture now returns `404`, proving the route can be mutation-smoked without touching live offers. |
| Resignation/termination vacancy guard | 4.6 | 4.7 | Nonexistent employee fixture returns `404` instead of a generic workflow failure. |
| Sales import workflow guard | 4.3 | 4.5 | Upload/action/approve guard paths are browser-smoked with safe fixtures. |
| Payroll upload/workflow guard | 4.6 | 4.7 | Upload/replace/workflow validation paths are browser-smoked with safe fixtures. |
| Expense import guard | 4.5 | 4.6 | Missing-period approved expense import guard is verified. |
| Vacation readiness guard | 4.2 | 4.3 | Request and decision validation paths are verified without creating requests. |
| Outstation readiness guard | 3.9 | 4.0 | Submit/admin ID validation now returns controlled client errors; approval automation still does not exist. |
| Controlled mutation smoke coverage | 4.2 | 4.5 | Safe fixture mutation probes are now repeatable and regression-backed. |

Remaining Phase 14 production gaps:

1. This phase intentionally did not create, approve, reject, replace, delete, or terminate real records in the live dataset.
2. Probation termination safe fixture returned `409` schema readiness in the current environment; service regression coverage still protects the shared termination path.
3. Real workbook upload success paths for employee import, sales import, payroll upload, and payroll replace still need a disposable seeded test database to mutate safely end to end.
4. Audit Logs were verified as reachable before and after safe probes; successful mutation audit trace creation remains covered by service/regression tests unless a disposable mutation fixture is available.
5. Outstation still has no admin approval mutation endpoint, so approval-to-expense/payroll remains a future workflow gap.
6. Security/RLS/auth hardening remains intentionally out of scope.

## Phase 15 Completion Update

Completed scope:

- Added `scripts/phase15-disposable-fixture-smoke.ts` to create clearly named `PHASE15` disposable fixtures and run successful database-backed workflow mutations end to end.
- Verified manual employee creation closes a matching disposable open vacancy.
- Verified resignation and termination update employee lifecycle state, remove the employee from effective organogram/payroll eligibility views, open the lifecycle/vacancy path, and now persist required shared `employee_resignation` audit traces.
- Verified accepted-offer approval creates the disposable employee, fills the matching disposable vacancy, and writes the existing offer domain audit trace.
- Verified sales import approve, reject, replace, and delete mutations through the existing sales workflow service, including domain and shared audit traces.
- Verified payroll upload, payroll replace, and payroll approval workflow through the existing payroll services and shared audit trace.
- Verified approved expense import targets the disposable payroll batch after satisfying the Part 1 paid workflow precondition.
- Verified vacation request/approval readiness with disposable request/event/audit rows.
- Verified Command Center-compatible workforce total formula, Data Health totals, Monitoring totals, and Platform workforce formula after fixture mutations.
- Added `scripts/phase15-tsx-email-stub-loader.mjs` so the standalone Node smoke can import service paths that reference TSX email modules without sending email from fixture runs.
- Added `tests/phase15-disposable-fixture-smoke.test.ts` to protect the Phase 15 smoke runner, PHASE15 fixture isolation, cleanup guard, existing service usage, and the resignation audit fix.

Disposable mutation score updates:

| Workflow | Before | After | Reason |
|---|---:|---:|---|
| Disposable employee hire -> vacancy close | 4.7 | 4.8 | Successful live disposable mutation verified with matching vacancy filled. |
| Resignation/termination -> vacancy/audit | 4.7 | 4.9 | Successful disposable mutations verified; effective organogram/payroll exclusion and shared audit trace gaps fixed. |
| Accepted offer -> employee/vacancy | 4.6 | 4.8 | Successful disposable accepted-offer approval verified against the real service/RPC path. |
| Sales approve/reject/replace/delete | 4.5 | 4.8 | Successful disposable mutations verified with domain and shared audit traces. |
| Payroll upload/replace/approval | 4.7 | 4.8 | Successful disposable payroll workflow verified through existing services. |
| Approved expense import | 4.6 | 4.7 | Import verified after enforcing the payroll Part 1 paid precondition. |
| Vacation request/approval readiness | 4.3 | 4.5 | Disposable vacation request, decision, event, and audit rows verified. |
| Operational totals after mutations | 4.5 | 4.7 | Data Health, Monitoring, and workforce total formula checks pass after mutations. |
| Disposable fixture mutation coverage | 4.5 | 4.8 | Real successful mutations are now repeatable with PHASE15 fixture isolation. |

Remaining Phase 15 production gaps:

1. Probation termination could not be mutation-verified in this environment because the live `employee_probation` schema is missing `probation_start_date`/workflow readiness columns expected by the current service.
2. Approved payroll fixture batches are intentionally locked by payroll business rules after Part 1 paid/approval, so cleanup leaves clearly named `PHASE15` payroll fixtures where the app correctly refuses destructive deletion.
3. Vacation approval was verified through disposable DB request/event/audit rows in the standalone smoke runner because direct Node service imports pull TSX email templates; browser/API service coverage remains separate.
4. Outstation approval-to-expense/payroll automation still does not exist.
5. Security/RLS/auth hardening remains intentionally out of scope.

## Phase 16 Completion Update

Completed scope:

- Added an idempotent production migration for probation workflow tables/columns expected by the current probation service.
- Added database-level enforcement for terminal employee raw lifecycle flags so `resigned`, `terminated`, and `inactive` employees are persisted with `payroll_eligible = false` and `organogram_visible = false`.
- Added outstation approval-to-payroll readiness through `approveOutstationRequestForPayroll`, reusing the existing payroll expense approval boundary instead of duplicating expense logic.
- Added required shared audit traceability for outstation approval mutations.
- Added `scripts/phase16-disposable-fixture-smoke.ts` to run PHASE16-only disposable lifecycle, probation, vacation service, outstation approval, and payroll cleanup-readiness checks.
- Added regression coverage for the Phase 16 migration, terminal flag enforcement, outstation approval service wiring, PHASE16 fixture isolation, and payroll cleanup lock discipline.

Production gap burn-down score updates:

| Area | Before | After | Reason |
|---|---:|---:|---|
| Probation disposable mutation readiness | 3.8 | 4.7 | Required workflow tables/columns are now migration-backed and PHASE16 smoke targets the real app service path. |
| Terminal raw lifecycle flags | 4.3 | 4.8 | Effective views were already correct; raw flags now have DB-level enforcement and backfill. |
| Payroll fixture cleanup readiness | 4.0 | 4.5 | Cleanup strategy uses service deletion only and avoids weakening locked payroll approvals. |
| Vacation service approval smoke | 4.5 | 4.7 | PHASE16 smoke imports vacation services with the existing TSX email stub loader. |
| Outstation approval payroll readiness | 3.8 | 4.5 | Approved outstation requests now create approved payroll expense rows through the shared expense source. |
| Audit trace consistency | 4.4 | 4.7 | Outstation approval now writes a required shared audit log entry. |

Remaining Phase 16 production gaps:

1. Approved payroll batches remain intentionally non-deletable after lock/approval; cleanup should retain those named disposable fixtures or use a fresh disposable database reset, never raw unlock updates.
2. Vacation approval now has service-level smoke coverage; payroll deduction/addition automation for leave remains future workflow work.
3. Outstation approval creates approved payroll expense rows, but full UI approval controls can still be added later without changing the shared service.
4. Sales workflow is still app-service multi-step rather than a single DB RPC transaction.
5. Security/RLS/auth hardening remains intentionally out of scope.

## Phase 17 Completion Update

Completed scope:

- Added an admin outstation approval POST endpoint that consumes `approveOutstationRequestForPayroll`.
- Added the admin Outstation Requests UI action to approve eligible submitted requests into the payroll expense pipeline through the shared API/service path.
- Hardened sales import approve/reject mutations with current-status guards, duplicate/failed-row approval guards, stale-state detection, and old-status audit context.
- Kept payroll locked cleanup discipline unchanged; PHASE17 smoke avoids raw unlock updates and only documents/verifies readiness through non-lock weakening paths.
- Filtered PHASE disposable actors and 209x disposable payroll/sales periods out of the normal operational business activity feed while preserving raw audit/event records.
- Added `scripts/phase17-disposable-fixture-smoke.ts` for PHASE17-only disposable outstation, vacation, sales, metric, and monitoring-feed checks.
- Added regression coverage for the outstation UI/API closure, leave payroll-impact readiness, sales mutation guards, monitoring fixture filtering, and PHASE17 smoke isolation.

Final workflow closure score updates:

| Area | Before | After | Reason |
|---|---:|---:|---|
| Admin outstation approval UI/API | 4.5 | 4.8 | UI and API now call the shared outstation-to-payroll service instead of leaving approval service-only. |
| Leave approval payroll readiness | 4.7 | 4.8 | PHASE17 smoke verifies approved vacation decisions persist payment status, paid-day impact, and audit trace. |
| Sales approve/reject/replace/delete readiness | 4.8 | 4.9 | Successful PHASE17 mutations verified; approve/reject now guard stale and invalid states. |
| Payroll locked cleanup readiness | 4.5 | 4.6 | Lock weakening remains blocked; cleanup readiness is documented and smoke avoids raw unlock bypasses. |
| Operational monitoring fixture hygiene | 4.3 | 4.8 | Disposable PHASE actors and 209x fixture periods no longer pollute the default business activity feed. |
| Command Center/Data Health/Monitoring after workflow actions | 4.7 | 4.8 | PHASE17 smoke verifies all three load after disposable workflow mutations. |

Remaining Phase 17 production gaps:

1. Sales workflow mutations are still app-service guarded multi-step operations, not a single database RPC transaction.
2. Leave approval records payroll-impact readiness, but automatic payroll deduction/addition posting remains future workflow scope.
3. Payroll approved/locked fixture cleanup must continue to use fresh disposable database resets or retained named fixtures; do not unlock approved payroll rows for cleanup.
4. Raw Audit Logs intentionally still contain PHASE fixture traces for accountability; only normal operational business feeds hide them by default.
5. Security/RLS/auth hardening remains intentionally out of scope.

## Phase 18 Completion Update

Completed scope:

- Added a small shared fixture hygiene helper for PHASE disposable rows and 2090+ disposable fixture periods.
- Applied fixture-safe filtering to normal business-facing payroll, sales, expenses, platform workforce, Command Center, Data Health, and Monitoring read paths.
- Preserved raw Audit Logs visibility for PHASE fixture traces instead of silently deleting or hiding audit accountability.
- Added a read-only PHASE18 fixture hygiene smoke report covering employees, vacancies, payroll, sales, expenses, outstation, vacation, and audit traces.
- Confirmed the current database still has disposable residue: 1 PHASE employee row, 12 PHASE salary batches, 12 PHASE salary rows, and 17 raw audit traces.
- Confirmed Command Center uses the real latest payroll batch `4/2026` instead of retained 2099 disposable payroll fixtures.
- Added regression coverage for fixture hygiene rules and updated older dashboard wiring tests to accept the fixture-safe vacancy filter.

Fixture hygiene score updates:

| Area | Before | After | Reason |
|---|---:|---:|---|
| Shared fixture detection | 3.8 | 4.8 | PHASE text and 2090+ disposable periods now have one small reusable helper. |
| Payroll dashboard fixture safety | 4.2 | 4.8 | Retained 2099 salary batches no longer become the default latest payroll dashboard source. |
| Sales dashboard fixture safety | 4.6 | 4.8 | Normal sales reads filter disposable sales batches/records unless explicitly inspecting a batch. |
| Expense dashboard fixture safety | 4.5 | 4.8 | Expense metrics/reports exclude PHASE disposable rows from normal business totals. |
| Data Health fixture safety | 4.5 | 4.8 | Employee, vacancy, sales, vacation, and orphan audit health reads filter PHASE disposable rows. |
| Monitoring fixture safety | 4.8 | 4.9 | Operational activity keeps filtering PHASE fixture actors while raw security/audit feed remains available. |
| Fixture cleanup readiness | 4.6 | 4.8 | PHASE18 smoke reports residue read-only and documents locked payroll cleanup without unlocking. |

Remaining Phase 18 production gaps:

1. The database still contains disposable residue: 1 PHASE employee row, 12 PHASE payroll batches, 12 salary rows, and 17 raw audit traces.
2. Locked/approved payroll fixture cleanup should still use a disposable database reset or an explicit future cleanup plan, never payroll lock weakening.
3. Raw Audit Logs intentionally retain fixture traces for accountability; this is expected.
4. PHASE18 was read-only by design, so no fixture rows were deleted in this phase.
5. Security/RLS/auth hardening remains intentionally out of scope.

## Phase 19 Completion Update

Completed scope:

- Added a guarded PHASE19 cleanup smoke runner with read-only preflight by default and explicit `--execute` cleanup mode.
- Preflight identified one cleanup-safe `uploaded` PHASE15 payroll batch with one salary row.
- Cleanup deleted that safe payroll batch through the existing `deleteSalaryBatch()` service/RPC boundary.
- Cleanup deleted the one PHASE employee residue plus its direct employee location and compensation rows.
- Retained 11 PHASE15 payroll batches and 11 salary rows because they are approved or Part 1 paid.
- Retained raw PHASE audit traces for accountability.
- Verified Command Center, Data Health, and Monitoring after cleanup; Command Center still uses real payroll batch `4/2026`, not retained 2099 fixtures.
- Added regression coverage for the guarded cleanup script, protected payroll policy, dashboard verification, and raw audit retention.

Safe cleanup score updates:

| Area | Before | After | Reason |
|---|---:|---:|---|
| Cleanup preflight readiness | 4.4 | 4.9 | Cleanup now has a repeatable read-only preflight and protected/cleanup candidate split. |
| Safe payroll fixture cleanup | 4.5 | 4.8 | One editable uploaded PHASE payroll batch was removed through the existing payroll delete service. |
| Payroll lock discipline | 4.8 | 4.9 | Approved and Part 1 paid payroll fixtures were retained without unlocks or raw status changes. |
| Employee residue cleanup | 4.4 | 4.8 | The one PHASE employee residue and direct dependent rows were removed after workflow reference checks. |
| Dashboard fixture safety after cleanup | 4.8 | 4.9 | Command Center, Data Health, and Monitoring remain coherent with retained fixture rows filtered from business views. |
| Raw audit trace policy | 4.8 | 4.9 | Raw PHASE audit traces remain retained by policy while business feeds stay clean. |

Remaining Phase 19 production gaps:

1. 11 PHASE payroll batches and 11 salary rows remain because payroll rules classify them as approved or Part 1 paid.
2. Raw PHASE audit traces remain intentionally retained for accountability.
3. Full removal of protected payroll fixture history should use a disposable database reset or an explicit archive policy, never lock weakening.
4. Security/RLS/auth hardening remains intentionally out of scope.

## Phase 20 Completion Update

Completed scope:

- Added a final read-only PHASE20 production readiness smoke runner.
- Verified protected PHASE payroll fixture policy without unlocks, deletes, or status rewrites.
- Verified raw Audit Logs remain accountable while normal operational business activity filters PHASE fixture noise.
- Verified Command Center, Data Health, Monitoring, and Platform Metrics still use fixture-safe shared totals after Phase 19 cleanup.
- Fixed the final Data Health workforce summary mismatch so active employee and structure totals now come from the shared Platform Workforce source used by Command Center.
- Documented final sidebar module scores and remaining production gaps excluding deployment and security/RLS/auth hardening.
- Added regression coverage proving the Phase 20 runner is read-only and checks the shared dashboard/metrics sources.

Protected Fixture Retention Policy:

- Retain approved, locked, or Part 1 paid PHASE payroll fixture batches and salary rows.
- Do not unlock, downgrade, or delete protected payroll fixture rows through app cleanup.
- Keep protected fixture rows filtered from normal business dashboards and shared KPI sources.
- Keep raw Audit Logs accountable; PHASE traces may remain visible in raw audit surfaces.
- Use a disposable database reset or explicit archive policy for full protected-fixture removal, never lock weakening.

Final Sidebar Module Scores:

| Sidebar module | Score | Readiness note |
|---|---:|---|
| Command Center | 4.9/5 | Shared platform metrics, workforce totals, payroll fixture filtering, and operational feeds are connected. |
| Data Health | 4.9/5 | Shared workforce/data health totals are fixture-safe and coherent. |
| Monitoring | 4.9/5 | Operational business activity filters PHASE noise while raw security/audit feed remains reachable. |
| Audit Logs | 4.7/5 | Raw accountability is preserved; fixture traces are retained by policy. |
| Employees | 4.8/5 | Lifecycle seat rules and terminal employee handling are centralized. |
| Organogram | 4.6/5 | Workforce/vacancy continuity is connected; visual layout polish can still improve dense vacancy rendering. |
| Vacancies Report | 4.7/5 | Hire closes vacancy and terminal lifecycle opens vacancy through shared workforce logic. |
| CV Database | 3.4/5 | Basic module remains functional; deeper recruitment pipeline automation is still limited. |
| Offer Lifecycle | 4.8/5 | Accepted offer conversion uses workforce seat rules and auditability. |
| Hiring Documents | 4.5/5 | Onboarding readiness is linked to shared recruitment/onboarding metrics. |
| Probation | 4.8/5 | Probation termination uses shared terminal lifecycle path with schema readiness covered. |
| Contract Renewal | 4.7/5 | Lifecycle risk windows and renewal readiness are centralized. |
| Resignations | 4.8/5 | Resignation opens vacancy and updates effective organogram/payroll views. |
| Fingerprint Report | 4.3/5 | Attendance readiness is shared; end-to-end device ingestion remains lighter than core workflow modules. |
| Device User Mapping | 4.3/5 | Mapping health has a shared source; production data completeness still depends on real device data. |
| Attendance Policies | 4.3/5 | Policy readiness is centralized; advanced attendance workflow automation remains future scope. |
| HR Calendar | 4.2/5 | Working-day logic is reusable for leave calculations; calendar governance can still mature. |
| Monthly Sales | 4.8/5 | Import/approve/reject/replace/delete logic is service guarded and shared. |
| Sales Dashboard | 4.8/5 | Approved sales, targets, trends, and fixture filtering use shared sales sources. |
| Field Coaching | 4.2/5 | Coaching flows are stable but less deeply integrated into platform KPIs than sales/payroll/workforce. |
| Coaching Analytics | 4.2/5 | Analytics are covered by focused tests; broader executive KPI integration remains optional. |
| Payroll Report | 4.8/5 | Payroll workflow, approved expense import, lock discipline, and fixture filtering are protected. |
| Payslips Center | 4.5/5 | Employee payroll visibility is connected; production readiness depends on final payroll publication rules. |
| Expenses | 4.8/5 | Approved/total/report/team metrics use shared expense sources. |
| Expenses Dashboard | 4.8/5 | Dashboard, platform metrics, and payroll import agree on shared expense logic. |
| Outstation Requests | 4.8/5 | Admin approval can create approved payroll expense rows through the shared service/API. |
| Outstation Policy | 4.4/5 | Policy classification is covered; policy administration depth can still expand. |
| Outstation Heatmaps | 4.2/5 | Visualization reads are stable; deeper analytics remain future enhancement scope. |
| Vacation Request | 4.7/5 | Calendar-aware days, balances, decisions, and readiness are centralized. |
| Vacation Report | 4.7/5 | Report KPIs align with shared leave/calendar logic. |
| Users & Access | 4.0/5 | Access surfaces are operational; security/RLS/auth hardening is intentionally excluded from this build pass. |
| Email Composer | 4.4/5 | Send/log readiness is tied to shared communication sources. |
| Email Templates | 4.5/5 | Template readiness metrics are centralized. |

Connected non-sidebar surfaces:

| Surface | Score | Readiness note |
|---|---:|---|
| Overview | 4.8/5 | Uses shared platform, operational, recruitment, sales, payroll, expense, and leave sources. |
| Employee Portal | 4.6/5 | Sales, payroll, expenses, notifications, and leave visibility are connected where implemented. |

Production-ready areas excluding deployment:

1. Workforce lifecycle seat continuity across manual hire, bulk hire, offer conversion, resignation, termination, and probation termination.
2. Shared platform KPI sources for Command Center, Data Health, Monitoring, Overview, and dashboard aggregators.
3. Payroll/expense/source-of-truth paths including approved expense import and protected payroll lock discipline.
4. Sales import workflow readiness with shared sales metrics and territory/seat continuity.
5. Recruitment, offer, onboarding, hiring-document, leave, lifecycle risk, communication, and notification metric boundaries.
6. Disposable fixture hygiene: normal dashboards stay clean while raw audit accountability is preserved.

Remaining Phase 20 production gaps:

1. Protected PHASE payroll fixture rows remain retained by policy: 11 batches and 11 salary rows from Phase 19.
2. Raw PHASE audit traces remain intentionally retained for accountability.
3. Sales approve/reject/replace/delete remains app-service guarded multi-step logic rather than a single database RPC transaction.
4. Leave approval records payroll-impact readiness, but automatic leave-to-payroll posting remains future workflow scope.
5. Organogram dense vacancy rendering needs UI polish; the underlying workforce/vacancy logic is connected.
6. CV Database, Attendance, Field Coaching, Coaching Analytics, and some Access/Communication areas are usable but below the 4.8+ core workflow readiness band.
7. Security/RLS/auth hardening and deployment remain intentionally out of scope for this closure pass.
