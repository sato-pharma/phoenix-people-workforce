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
| Source of truth | 3 | Expense logic is split with payroll dashboard. | Create expense metrics DTO. |
| Cross-module linkage | 4 | Links payroll, employees, outstation. | Keep. |
| UI/API/service separation | 3 | Some dashboard logic outside service. | Move aggregation to service. |
| Test coverage | 2 | Limited direct expense workflow tests. | Add approval/import tests. |
| Production readiness | 3 | Usable but needs consolidation. | P1. |

Module score: 3.3 / 5

### Expenses Dashboard

| Area | Score | Finding | Build action |
|---|---:|---|---|
| Data model ownership | 3 | Page loads employee directory; dashboard aggregates outside a canonical service. | Build expense dashboard service. |
| Workflow completeness | 3 | Dashboard exists. | Define canonical dashboard DTO. |
| Source of truth | 2 | Too much aggregation outside service. | Move to `expense-metrics.ts`. |
| Cross-module linkage | 3 | Links employees/expenses/outstation but not cleanly. | Centralize linkage. |
| UI/API/service separation | 2 | Component/page-driven. | Refactor. |
| Test coverage | 1 | No obvious direct tests. | Add expense dashboard tests. |
| Production readiness | 2 | Needs service boundary before scaling. | P1. |

Module score: 2.3 / 5

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
