---
name: visits-checkins-accuracy-audit-2026-07-12
description: "2026-07-12 end-to-end audit of iReports360 visit/check-in ingestion accuracy — verdict + the one live gap."
metadata: 
  node_type: memory
  type: project
  originSessionId: f0609120-fde9-4513-b3c9-cc1a4eab70a7
---

2026-07-12 read-only audit: "is Phoenix pulling visits+check-ins 100% accurately, right place, nothing missing?" **Verdict: pipeline is accurate.** Verified against production (`ozucdzovmcqvepbozvqf`): 98,558 visits + 82,429 check-ins (Jan 1–Jul 11 2026).

Confirmed correct: idempotent upsert on `crm_visit_id`/`crm_checkin_id`; `visit_date_time` is a midnight-UTC placeholder on 100% of rows & matches `visit_date` (no TZ day-shift); `visit_type`/`crm_save_date` never null; **0** stored `agent_hr_id` mismatches vs directory, **0** shared crm_ids, **0** unmapped-but-mappable visits, **0** active mapped reps with no visits → attribution is to the right person. 80 of 81 unmapped CRM identities are deliberately-"resigned" departed reps. Pipeline source of truth is the `ireports360_visits`/`ireports360_checkins` mirror (see [[ireports360-crm-integration]]).

**The one live gap (RESOLVED at source, backfill pending):** active rep `Amira.Samy ( French Line / C )` = employee **CN-0005**, crm_id **1543**. Her 47 visit rows (2026-07-05..07-11) were all unmapped (agent_hr_id null). Root cause already fixed: her employees.crm_id was set to "1543" on 2026-07-12 01:01 UTC (by other session/HR). Rows stay stale-unmapped only until the next sync re-stamps them (10-day lookback covers the window) — or run a manual backfill (Super-Admin: Visits Report → Backfill, `POST /api/admin/visits-report/backfill` {dateFrom,dateTo}, ≤45d). NOTE: FWC live matrix self-heals immediately (resolveHrKey falls back to directory crm_id map at read-time), but Employee 360/NSM/DV query stored agent_hr_id only, so they need the mirror backfill to agree.

**"Unknown" visit types decoded (vendor omits label; `comment` field carries truth):** -5 (1642 rows) = **national HOLIDAYS** (Eid/Sham El-Nessim/Sinai Liberation/Christmas, ~94%); -6 (26) = **Casual Leave/Excuse**; -30/-20/-19/-21 + most -7 = admin/meeting/coaching/review (correctly "worked"). -5 & -6 are non-working days currently bucketed "CP/worked" — financially SAFE (CP never triggers deduction; holidays also excluded via isPublicHoliday) but a labeling inaccuracy. Optional owner-confirmed fix: map -5→holiday/blank, -6→AV.

**FWC deduction path is SAFE (confirmed [[payroll-deduction-rules-owner-spec]] adjacent):** recommendations.ts:344 skips `crmIdentity.confidence==='unresolved'` entirely (unmapped rep can't be auto-deducted); N-days are candidates only, need explicit HR "Approved for Payroll Deduction", export-only, no auto amount; public holidays excluded (recommendations.ts:410); SFE managers excluded (441).

Caveats (not corrupting data): Team Calendar day drill-down reads LIVE CRM not the mirror (can disagree when mirror stale, labels all non-regular as "campaign"); nsm-crm-compliance `fetchVisitsForDate` caps 12 pages/day and treats mid-scan error as end-of-data; Employee 360 check-in UTC-bounds vs Cairo-bucketing near-midnight edge. Daily lookback 10d + weekly wide-reconcile 120d in 30d slices → edits >120d old never re-synced (documented).
