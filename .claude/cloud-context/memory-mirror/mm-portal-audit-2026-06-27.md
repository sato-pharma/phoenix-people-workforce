---
name: mm-portal-audit-2026-06-27
description: "Deep read-only audit of Marketing Manager (A-9) portal — reports, approvals, edge cases, and the recommended landing page."
metadata: 
  node_type: memory
  type: project
  originSessionId: 77d1b67e-6071-4e33-b292-07ab1e57d207
---

Marketing Manager = seat **A-9**, `PhoenixRole "Marketing Manager"`, employee-portal, base scope **line** (mimics GPM), **no HR authority**. Audited read-only 2026-06-27 (9-lane workflow + 3 critics). Nothing fixed — all below are FINDINGS.

**Current landing is broken for MM:** `PortalCommandCenter` only branches PM/GPM/MR, so MM degrades to bare `StandardCommandCenter` (self payslip/leave only). `home-snapshot.ts` sales/trend/DV/expense widgets are hard-gated behind `isMr` → all null for MM. Vacation/excuse counts fail silently to 0 ("All clear" on a DB error). A dedicated MM branch is needed. See [[portal-overview-dashboard-build]].

**P0 latent leak:** `v_employee_portal_sales` has NO LA003/LA004/SS001 filter and the portal reads it without `stripRestrictedProductRows`. Any LINE aggregate folds CEO-only confidential sales into MM totals once prod data exists. Build landing sales widgets ONLY from confidential-stripped paths (monthly-closing / weekly-product-scope / ROI RPC), never the raw view. See [[la003-la004-confidential-products]].

**P1 over-scopes (line role, no HR authority):** Probation + Organogram are COMPANY-WIDE for MM; Probation ALSO exports company-wide (`assertCanExportProbation`→`canViewAllProbation`) — a matrix bypass (matrix only grants `probation:read`). Deductions = LINE-wide READ (other employees' financial/disciplinary PII) while payslips are SELF. Coaching+DV company-wide (MM sits in BOTH `coachingOversightRoles` AND `lineRoles`; fix = remove from oversight). ROI Intelligence is correctly LINE-bounded — the three SI surfaces are inconsistent.

**Approvals MM GIVES:** really only `marketing_review` step-3 approve/return/reject, and it is assigned to A-9 specifically (not role-wide). Plus conditional manager-seat decisions (plan/excuse/vacation) that fire ONLY if someone reports to A-9 (zero on staging) — org-seat power independent of the `weekly_plans approve = NO` matrix. Plus coaching self-acknowledge. **MM REQUESTS:** marketing draft/submit/resubmit, outstation, leave, excuse, support ticket, Report It ADR, attendance dispute, own plan. **Dead/misleading registry grants:** `recruitment.app_*` and `marketing.update_control_step` list Marketing Manager but route/service gates block them.

**IMPLEMENTATION STATUS (2026-06-28):**
- PR #565 MERGED (squash 14577e32): deductions→SELF; confidential view migration authored; honest pending-counts; dead-code scope cleanup; inbox aging + ROI/field-health streamed sections + intel hub.
- PR #567 MERGED (squash 6ad947fe): Line Sales Pacing + My Line People streamed sections; salary-on-landing fix (month label only per [[portal-no-salary-on-landing]]); canManageCoachingReports(MM)=false test. NOTE: concurrent PR #568 (salary fix by parallel session) removed PendingCountsUnavailable + access prop threading from portal-command-center.tsx.
- PROD MIGRATION APPLIED & VERIFIED (2026-06-28): 20260627130000_portal_sales_view_exclude_confidential applied to production ozucdzovmcqvepbozvqf — 7007 rows intact, 0 confidential rows, security_invoker preserved.
- PR #571 OPEN (branch codex/mm-cockpit-pass3, worktree _wt-mm-cockpit): 1-click inline decide (MmInboxClient "use client" — Approve 1-click, Return/Reject inline reason textarea, optimistic removal, 403 surfaced inline, custom decisionLabels); allowReject+allowReturn added to MarketingApproverInboxRow type+buildRow; restored PendingCountsUnavailable + access prop on PortalCommandCenter; RSC boundary fix (egp inlined, not imported from server module). check:harden green.
- DEFERRED still: exports/saved-views/digest, registry data-migration (P3 route-blocked), browser E2E. Owner directive: MM = head of department → keep broad analytics, make account powerful.

**Recommended landing = "Marketing Manager command center"** (6 priority sections): 1) marketing inbox/approvals — my action queue first, "awaiting my decision" with oldest-pending AGE badge, returned-to-me, oldest-first pending; 2) line ROI vs spend (with vs-last-period delta); 3) line sales pacing (confidential-stripped sources only); 4) field health — lead with exceptions (neglected reps, uncoached reps); 5) my line people (vacancies + line leave only — the safe people signals); 6) self-service trimmed to payslip + pending actions. Honest empty states everywhere; no LA003/LA004/SS001. See [[no-text-truncation-or-wrapping]] and [[premium-design-language]].
