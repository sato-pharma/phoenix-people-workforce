---
name: crm-double-visit-audit-and-collapse-flag-2026-07-31
description: "CRM-fed modules audit (2026-07-31): burst-duplicate collapse gap + new opt-in collapseDoubleVisits door flag; 3 PRs shipped. How to count double visits correctly."
metadata: 
  node_type: memory
  type: project
  originSessionId: c6cd09fa-b26a-479d-9586-0eb5b67d4246
  modified: 2026-07-31T18:44:42.823Z
---

Full audit of every CRM-fed module for the double-visit "doubling" class, after the Team Calendar co-credit fix ([[team-calendar-visit-numbers-doubled-double-credit]]). 5 parallel audit agents + code/prod verification. **Shipped + deployed to production 2026-07-31 (revision phoenix-hr-00736), 3 PRs merged to main (final commit f16f1770):**

**The recurring gap (P2, PR #1507):** consumers that read raw visits via `queryVisits`/`queryVisitsLimited` skip the iReports360 burst-duplicate collapse that `getDoubleVisitRows` applies automatically, so double-visit COUNTS were modestly inflated (~up to the ~17% burst-dup share of double visits). Fixed at: probation SFE evidence (`sfe-evidence.ts` — feeds the frozen SFE decision snapshot), Employee 360 (`service.ts` fetchVisitRows + `deep-service.ts` getLeadershipActivity — the latter also counted non-fieldwork double rows, fixed with a `visitTypes: CRM_DOUBLE_VISIT_TYPE_CODES` filter), MR landing double-visit pulse (`home-snapshot.ts`), portal "Double Visits (N)" badge (`my-crm-visits.ts`).

**THE FIX / RULE:** added an opt-in `collapseDoubleVisits?: boolean` flag to `queryVisits` AND `queryVisitsLimited` in `src/lib/crm/reads.ts` (default OFF so raw-mirror browsers like CRM Master stay byte-identical). When ON it widens the projection to the duplicate-detection columns and runs `collapseDuplicateDoubleVisitSubmissions` internally. **Any new code that SUMS/COUNTS double-visit rows must either pass `collapseDoubleVisits: true` or use `getDoubleVisitRows` — never count raw `queryVisits` rows.** No-op for single visits, so it's safe on a full activity-mix read.

**Other gaps shipped:** #1509 — CRM Master scoped filter (`master.ts` applyMasterFilters, shared by browser + export) matched `agent_hr_id` case-SENSITIVELY, silently under-completing a scoped DM/RM's view; fixed by wrapping the allow-set in `expandHrIdFilterValues` (the case/alias expansion every other door read uses). #1511 — leaver payroll (`automated-payroll/recommend.ts` computeLeaverCrmDates) could recommend deducting a full settlement from an UNMAPPED field leaver read as all-no-activity; added a guard mirroring the FWC "unresolved CRM identity" skip (no crm_id AND `getMappedAgentHrIds` finds no mirror presence → return empty).

**Confirmed CLEAN (no fix needed):** Double Visit Analytics (already collapses + separates team-total from "your own"), the payroll/deduction paths (deductions key off no-activity days, so extra visit rows only ever UNDER-deduct), NSM presence board, attendance day-maps, rep-day drill-down, CRM Integrity, the CRM "one-door" itself. No co-credit (2×) doubling exists anywhere except the already-fixed FWC/Team-Calendar surface.

**Latent, NOT fixed (verified not currently occurring):** deduction_candidate `source_record_id` key mismatch — pending path builds `live:<month>:<key>:pending`, approved path builds `<month>:<key>` → different candidate_key → wouldn't dedupe. Prod check 2026-07-31: 84 live FWC no_activity candidates, 0 coexisting duplicates (all pending, 0 approved-live), so it does NOT manifest today — harden the key if touched. Also `scanVisitsForRange` (reads.ts) paginates with no ORDER BY (skip/dup risk if a sync writes mid-scan; feeds the FWC matrix) — deterministic-order hardening candidate. Relates to [[keyset-pagination-orderby-id-trap]], [[sos-unordered-pagination-lost-mappings]].
