---
name: module-audit-2026-08-01-status
description: "Whole-codebase module deep-dive audit (21 groups + gap-fill + verify) — state, verified DB facts, and how to resume if interrupted"
metadata: 
  node_type: memory
  type: project
  originSessionId: e0491122-d75a-469e-8531-3c35cc29cb82
  modified: 2026-08-01T16:24:14.894Z
---

# Whole-codebase module audit — 2026-08-01 — resume sheet

Owner asked: "dig deep into every module, then recommend value based on real findings."
Run from the main-checkout session (another session PID 11168 was active in the folder →
this audit was strictly READ-ONLY; no repo edits, no commits).

## State (update as phases complete)

1. ✅ Inventory: 74 src/lib domains, 19 admin areas, 62 portal pages, 49 component domains.
2. ✅ Deep-dive workflow `wf_b5913686-abd` (21 module auditors + completeness critic, 22/22 ok).
   - **Full digest: [module-audit-2026-08-01-digest.md](module-audit-2026-08-01-digest.md)** (all gaps/recs/evidence per module — the core asset).
   - Raw JSON: `module-audit-2026-08-01-raw.json`. Session journal (if session still exists):
     `...\e0491122-d75a-469e-8531-3c35cc29cb82\subagents\workflows\wf_b5913686-abd\journal.jsonl`.
3. ✅ Verify workflow `wf_6db2a1ad-d04` COMPLETE (first run lost the 7 verifiers to a session-limit
   reset; resumed from cache and all 10 finished). Verdicts persisted:
   [module-audit-2026-08-01-verdicts.md](module-audit-2026-08-01-verdicts.md) · gap-fill:
   [module-audit-2026-08-01-gapfill.md](module-audit-2026-08-01-gapfill.md). Most headline claims
   CONFIRMED (outstation is WORSE: online submit lets the client self-flag offlineCaptured to skip
   the ticket mandate). Refuted/narrowed: car-evidence cross-employee (server forces hrId segment),
   notifyExpensesAddedToPayroll (deliberately off, test-enforced), pinConfidence legacy names (the
   offline scripts wrote them — real gap is google/locationiq/field_gps unhandled), ROI staleness
   (self-heals when later uploads overlap the window), portal salary fallback (empty-state gated;
   missing "estimated" label is what stands).
4. ✅ Final report DELIVERED 2026-08-01, and **UPDATED later the same day to cover the whole
   session** (both audits, what shipped, what's queued, what's open) — same URL, republish the same
   file path (`scratchpad/phoenix-module-audit.html`) to update it again:
   **https://claude.ai/code/artifact/a3583989-4841-475b-bdcd-748c8f8c2b2a**
   (ranked broken-now list, 3 systemic patterns, quick wins, owner decisions, per-module detail,
   verification corrections). AUDIT CLOSED — remaining value is executing fixes, each needing its
   own branch/session per the parallel-work model.

## Live-DB facts verified 2026-08-01 (prod ozucdzovmcqvepbozvqf, staging cifwmndunmlxjhyjugxa)

- **SoS confidential migrations APPLIED in prod AND staging** (prod migration
  `20260801024017 analytics_sos_confidential_basis`, all 4 analytics_sos_* fns have
  p_exclude_codes in both DBs). The old "applied nowhere" memory is corrected in
  [[sos-remediation-13-phase-plan-2026-07-31]]. CEO/SA hard-fail concern is MOOT live.
- **Contract renewal BROKEN in prod**: `phx_create_contract_renewal_request` /
  `phx_apply_contract_renewal_workflow` do NOT exist (any schema; only the archive has them);
  `contract_renewal_requests` = 0 rows (never worked since baseline). HIGH, confirmed live.
- Weekly-plan widened unique index `employee_plan_headers_active_period_uidx` IS live in prod
  (predicate excludes only draft/cancelled/manager_rejected/ceo_rejected) → revise-of-approved
  23505 collision mechanism is armed.
- `role_permission_overrides`: zero weekly_plans rows → CEO/Manager plan-comment 403 not masked.
- `geo_locations.geocode_provider` prod distribution: google 1671, google_places_hint 630,
  google_geocode 376, google_block_centre 21, locationiq 9, google_area_centre 1, **manual 1**,
  field_gps 0. → pinConfidence's "dead" legacy branches actually match ~1028 rows, but majority
  provider `google` falls to Unverified-50%; manual-pin-overwrite bug is preventive (1 pin today).
- `marketing_pharmacies` = 287 (pharmacy-master 1000-row truncation gap dormant).
- Bricked direct-order reversals in prod = 0 (reversal-lifecycle bug preventive, not incident).

## Critic's coverage/skepticism notes (fold into synthesis)

- Uncovered by the 21 groups, now assigned to gap-fill: report-it (real PII module, fake test
  coverage), platform/metrics.ts (473 lines, unaudited), admin modules-control/command-center/
  system-cleanup, hr-calendar access gate, market/egx.ts (Yahoo dep), app/payslips + app/employee/*
  root-level pages.
- Treat with skepticism until verify returns: weekly-planning SA-queue/CEO-comment absolutes,
  auth XFF spoofability severity, workflow-registry "one click kills a domain" (hardening, not
  defect), payroll "fabricated figures" framing (check UI suppression), attendance top rec
  (imported from incident memory, not code evidence).
- Dedupe: two-portal-attendance-pages finding reported by BOTH attendance-fwc and portal-shell.
