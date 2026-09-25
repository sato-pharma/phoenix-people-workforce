---
name: report-it-module-build
description: "Report It pharmacovigilance ADR reporting module — current build state, files, and pending steps"
metadata: 
  node_type: memory
  type: project
  originSessionId: 06f7989f-6910-4a16-973a-673ad1fd295c
---

Full pharmacovigilance ADR reporting module. **SHIPPED TO PRODUCTION 2026-06-10** via PR #99 (engine, commit 88ca290) and PR #100 (admin-shell fix, commit 26afe36), both merged to main + deployed (Vercel Ready). Production migration `20260610130000` applied via MCP (report_it_reports = 19 cols, report_it_audit_logs = 6 cols, verified live).

**Admin-shell fix (PR #100):** the admin "Report It" nav link originally pointed at `/employee-portals/report-it`, which dropped admin-mode users into the employee-portal shell (looked like an unexpected "redirect to employee portal"). Fixed by adding `app/(admin)/admin/report-it/new/page.tsx` (same ReportItForm, `report_it:create`-gated) and repointing the admin nav to `/admin/report-it/new`. Employee portal route `/employee-portals/report-it` unchanged for portal-mode users.

**Why:** Company needs VigiFlow-style adverse drug reaction reporting; all 15 employee roles submit; QPPV-equivalent (Super Admin / CEO / Finance Manager — HR Specialist was retired 2026-06) see all reports and can export.

**Routes (live):** employees → `/employee-portals/report-it` (portal shell); admins → `/admin/report-it` (Reports Dashboard, export-gated) + `/admin/report-it/new` (submit a report, in admin shell).

## Files delivered (all committed)

| File | Role |
|---|---|
| `supabase/migrations/20260610130000_report_it_reports.sql` | DB — report_it_reports + audit_logs, RPT-YYYY-NNNNN sequence |
| `src/lib/report-it/types.ts` | TypeScript types + constants |
| `src/lib/report-it/service.ts` | Domain service: submitReport, listReports, getReport, getReportKpis, canViewAllReports, canExportReports |
| `src/lib/auth/permissions.ts` | Added `report_it` resource to all 15 roles |
| `src/config/system-navigation.ts` | Pharmacovigilance section in admin + portal nav |
| `app/api/report-it/submit/route.ts` | POST — all authenticated employees |
| `app/api/report-it/list/route.ts` | GET — self-only or all depending on role |
| `app/api/report-it/[id]/route.ts` | GET — ownership-gated single report |
| `src/components/report-it/report-it-form.tsx` | 4-step form (patient, reactions, medicines, additional) |
| `src/components/report-it/report-it-admin-dashboard.tsx` | KPIs, filterable table, drawer, XLSX export |
| `app/employee-portals/report-it/page.tsx` | Portal page — all authenticated users, NO mode redirect |
| `app/(admin)/admin/report-it/page.tsx` | Admin page — assertPermission("report_it","export") |
| `src/lib/security/access-registry.ts` | 3 route entries (guard: "domain-helper") |
| `tests/report-it-access.test.ts` | Unit tests for RBAC functions + matrix |
| `tests/run-tests.ts` | Wired in runReportItAccessTests |

## RBAC
- Admin roles (Super Admin, CEO, Finance Manager): `allActions` / `["read","create","export"]` — see ALL reports, can export. **HR Specialist was in this list and is NOT any more** — the role was retired 2026-06 and the seat that replaced it never regained the grant; verified live 2026-08-28, it is these three and nobody else. See [[report-it-sounds-like-hr-and-is-patient-data]] for why an HR seat must never be added back.
- All other 11 roles: `["read","create"]` — see own reports only, no export

## Status
Core module DONE & live in prod (PR #99/#100/#101, migration applied).

**FK BUG FIXED (PR #104, branch codex/report-it-fix-submitter-fk):** submit failed with `report_it_reports_submitted_by_hr_id_fkey` violation — the FK on submitted_by_hr_id→employees(hr_id) did a RAW case-sensitive match, but the `admin-HR` Super Admin session id resolves to `ADMIN-HR` (case mismatch; employees has BOTH 'admin-HR' and 'ADMIN-HR' rows). Dropped the FK (it's denormalized attribution, like audit_logs.actor_hr_id which has no FK) via migration 20260610123725 — **APPLIED TO PROD 2026-06-10, verified gone**. Repo migration file matches the prod version. Also hardened submit route to look up employee metadata via hrIdLookupKeys (case/alias tolerant). PR #104 MERGED & deployed 2026-06-10 (merge fa50d17). Lesson: never FK a column to employees(hr_id) — hr_id needs canonical matching (hrIdLookupKeys), raw compare is forbidden.

**PREMIUM REDESIGN — PR #103 MERGED & DEPLOYED to prod 2026-06-10** (merge fde3f26, deploy 4ib3xnz0d Ready). Premium two-column "console": dark slate-900 hero w/ phoenix mark (systemAssets.adminRailMark) + progress bar, left vertical-stepper rail filling dead space, elevated form card, lighter block headers, mobile horizontal stepper, max-w-6xl. 3-lens adversarial review caught & fixed a lg-band date-row collapse (grids go 1-col at lg where rail+sidebar squeeze, re-expand xl/2xl). Note: could NOT screenshot locally (parallel session held main dir; Next 16 Turbopack rejects node_modules junction in worktrees) — verified via static gates + review, shipped to prod for visual confirmation.

**"Nothing changed" lesson:** user reported no change because BOTH PRs sat unmerged — only the DB FK-drop was live (invisible). Don't leave approved visual work in unmerged PRs; deploy so the user can see it.

**Parallel-session note:** main working dir is on another session's branch; always use an isolated worktree for report-it work.
