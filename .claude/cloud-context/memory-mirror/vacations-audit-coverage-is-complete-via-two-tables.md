---
name: vacations-audit-coverage-is-complete-via-two-tables
description: "The vacation module has NO payroll-style audit gap — every human mutation names its actor, but 4 paths record it in v2_vacation_request_events, not audit_logs"
metadata: 
  node_type: memory
  type: project
  originSessionId: 26968de2-24de-4b16-a339-4065a48eba87
  modified: 2026-08-21T00:34:08.091Z
---

Swept 2026-08-21 after fixing the payroll gap ([[payroll-mutations-were-unaudited-until-2026-08-21]]).
**The same gap does not exist here.** Do not open a "vacations audit" PR without re-deriving this.

Vacation history lives in **two** places, and reading only `audit_logs` makes coverage look worse
than it is:

| path | `audit_logs` row | `v2_vacation_request_events` |
| --- | --- | --- |
| admin create / update / delete | ✅ | ✅ |
| decision — sequential, legacy, **and by email token** | ✅ | ✅ |
| resubmit · assign approver · weekly-off policy | ✅ | ✅ / — |
| **employee self-service submit** | ❌ | ✅ `submitted` |
| **evidence review** | ❌ | ✅ `evidence_reviewed` + `v2_vacation_evidence_reviews` |
| retention purge · SLA daily | ❌ | own run tables |

Measured on production: 320 requests, **313 carry an `audit_logs` row**. The 7 that don't are
6 rows bulk-inserted at one identical timestamp (2026-07-09 10:28:11, zero events — a backfill)
plus 1 still `pending_manager`, which has its `submitted` event. **A self-service request gets its
first `audit_logs` row only when someone decides on it** — that is why the shortfall looks like a
gap and is not one.

Actor columns are populated, not decorative: **29/29** `submitted` events name an actor, **3/3**
evidence reviews name their reviewer. The 292 event rows with no actor are `sla_reminder`,
`sla_escalation`, `notification_failed` — system events with no human behind them.

`decideVacationRequestByToken` looks unaudited by grep but delegates to `applyVacationDecision`,
which is audited. Do not "fix" it.

**Why:** the module predates the audit-log idiom for some paths and grew its own event table, which
carries richer data (event_type, metadata, note) than an `audit_logs` row would.

**How to apply:** the one genuine weakness was `runVacationRetentionPurge` — it deletes
`v2_vacation_requests` rows and recorded only **counts** in `v2_vacation_retention_purge_runs`,
never which rows died, and `recordRetentionPurgeRun` swallowed a missing-schema error so a purge
could destroy rows and record nothing. **It has never run: 0 rows in that table, 0 real purges** —
latent, not live. **Fixed by PR #2243**: the targeted rows are read before any delete and carried
into a required audit row under the new entity type `vacation_retention_purge`, the manifest flags
truncation past 2000 rows instead of dropping the tail, a dry run writes no audit row, and the
missing-run-table path now logs `event=vacation_retention_purge_run_unrecorded`. The manifest says
**targeted, not purged** — the request delete runs last, so an earlier failure leaves those rows
standing and only `deletedCounts` says who actually died.

**Proven end-to-end on staging 2026-08-21**, not just unit-tested. Staging's `request_history`
retention is **2555 days (7 years)**, so a real purge there deletes nothing — 3 throwaway 2015 rows
had to be seeded to give it anything to bite. Dry run: 3 candidates, 0 deleted, **0 audit rows**.
Real run: 3 requests + 1 event deleted, **1 audit row** carrying all 3 ids with name, type, dates,
status and `createdAt`. The 30 genuine staging requests survived untouched (oldest 2026-06-28) and
production stayed at 320 requests / 0 purge rows throughout. `detailTruncated` was `false` at this
size — the >2000-row truncation branch is pinned by the test, not by this run. **The proof rows were
deleted afterwards** (1 `audit_logs`, 2 `v2_vacation_retention_purge_runs`), so staging is back to
0/0 — do not go looking for them as evidence.

Running the service standalone needs `scripts/alias-loader.mjs` **extended**: it maps `next/server`
and `next/headers` but not `next/cache`, and Node cannot strip types from the `.tsx` email
templates the service transitively imports. See [[running-vacation-service-standalone-needs-an-extended-loader]].
