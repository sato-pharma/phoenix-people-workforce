---
name: crm-single-source-visit-time-and-counts
description: "The CRM (iReports360 mirror) is the single source of truth for visits/check-ins; visit-time + FWC-Excel-removal + mixed-day work shipped 2026-07-20."
metadata: 
  node_type: memory
  type: project
  originSessionId: a07c2cca-3ac7-4643-acc0-59ad7345bb0f
  modified: 2026-07-19T23:09:40.817Z
---

Owner mandate (2026-07-20): make the iReports360 CRM mirror the ONE source of truth for visits/check-ins across all modules, remove the FWC Excel import, and get visit TIME correct. Verified the single-door read architecture already existed and is CI-enforced ([[crm-single-source-door-guardrail]]); the one real second source was the FWC Excel upload. Shipped as 4 stacked/independent PRs (all pushed, NOT yet merged — need role-testing + owner merge):

- **PR0 #1190** — fixed a red CI test I'd broken (retention-cleanup moved to daily cron; email-production-readiness P1-8 now checks the daily route).
- **PR1 #1192** (`codex/crm-visit-time-canonical`) — canonical visit time. iReports360 has NO on-site visit time: `visit_date_time` is `00:00` on 100% of rows; screens fell back to `crm_save_date` (submission/paperwork time) which prod-verified was off by >1h for 45% / wrong DAY for 15% of the 14,491 visits-with-GPS over 30 days (reps batch-log later). New `resolveVisitTime` in `crm/reads.ts` (the single door): **GPS check-in → save time → none, never visit_date_time**. Every `VisitsReportRow` now carries `visitTime`+`visitTimeSource`; surfaced on `/admin/crm` (new Visit Time + Source cols), Visits Report (col+export, GPS/Logged badge), fixed NSM early-bird midnight-fallback bug. Display double-shift was ALREADY fixed (#1076) — see [[ireports360-timestamps-cairo-local-mislabeled-utc]].
- **PR2 #1193** (`codex/fwc-remove-excel-import`) — removed the FWC Excel import entirely: 7 routes + export.ts + its test deleted; parser/preview/archive/recommendations trimmed to live-only; workspace UI stripped of upload+Archives+Comparison; -3706 lines. NO payroll break (deductions read shared `field_workforce_compliance_decisions` + live no-activity sync). The 3 `field_workforce_compliance_*` archive tables are now ORPHANED (no writer) — drop via a separate migration after a retention decision.
- **PR3 #1196** (`codex/fwc-mixed-day-count`, STACKED on PR2) — a mixed day (regular visits + campaign) used to collapse to "CP", hiding+dropping the regular visits. Now `dayCellValue` counts the regular visits (status VISITS) and flags the campaign via a `campaignOverlay` side-map (same pattern as loggingTiming); grid shows a 2-color split square. PAYROLL-ADJACENT (mixed days now add to visit total/compliance → deduction inputs) — role-test before merge.

The 5-vs-8 divergence is mostly DELIBERATE (FWC = Regular-only compliance count; DV = doubles-only; Vacation = -4 only) — owner chose "keep the deliberate filters, make traceable." Still-open optional consistency items NOT done: shared visit-type taxonomy, NSM `visit_type >= 0` → canonical `{0,-8}` predicate, a reconciliation test. Full audit lives in the count/time/FWC-removal explore-agent reports from that session.
