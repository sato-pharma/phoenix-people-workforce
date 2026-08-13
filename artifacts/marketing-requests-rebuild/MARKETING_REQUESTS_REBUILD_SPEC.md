# Marketing Requests — Rebuild Specification

**Branch:** `codex/marketing-requests-rebuild` (off `origin/main` @ `12d20d19`)
**Baseline:** the forensic audit in `artifacts/marketing-requests-audit/`. Its conclusions are taken
as settled and are not re-derived here.

This is an implementation contract, not analysis.

---

## 0. What is already live (do not rebuild)

Merged and serving production at revision `12d20d19` on 2026-08-13:

| | Shipped | Evidence |
| --- | --- | --- |
| **#2072** | A requester sees their own rejected request, with reason, actor, Cairo time | browser-verified desktop + 375px |
| **#2079** | `/marketing-requests/[requestId]` renders the Case File instead of redirecting | `GET` → **200** (was 307) |
| **#2082** | `marketing_request_events` — append-only, 4 triggers, 11 backfilled events | UPDATE/DELETE/**TRUNCATE** all refused in prod |
| **#2087** | Self-approval refused at chain build, service and the decision RPC | self + casing blocked, third party allowed |

So Priorities **1, 2 (storage), 3, 5, 7, 8** are done. This spec covers what is left.

**Reuse, do not duplicate:**
`case-file-service.ts` (1,222 lines, assembles ~95 fields) · `case-file-types.ts` (the three-state
`CaseFileBlock`) · `marketing-request-case-file.tsx` (the detail view) ·
`marketing_request_events` (the history) · `cairoDateTime` / `plainDate` in
`request-report-columns.ts` (the Cairo formatters).

---

## 1. Canonical routes

Target, from the audit's IA:

```
/marketing-requests              work queue — role-aware, URL-encoded filters
/marketing-requests/[id]         THE CASE FILE  ← live
/marketing-requests/new          creation
/marketing-requests/[id]/edit    resubmit after return
/marketing-requests/reports      one reporting surface (today: five)
/marketing-requests/admin        control · validation · customer database · bulk upload
```

**Backward compatibility is non-negotiable.** No legacy URL is deleted in this rebuild. Portal,
admin and `/workspace/**` paths become redirects only after the canonical target exists and is
verified. Historical notification `actionUrl`s already point at `/marketing-requests/<id>`, which is
live — those are repaired, not at risk.

**Documented deviation:** the three shells (`/employee-portals`, `/admin`, `/workspace`) exist
because `resolveNavigationMode()` routes roles to different guards. Collapsing them is Wave 3 and is
sequenced last, because the CEO was previously locked out of the Approval Inbox by exactly this
class of change.

## 2. Status handling

`marketing_requests.status` permits 11 values; 7 have a writer. `pending_validation`, `roi_tracking`,
`closed` and `finance_hold` have none.

- A reject must **terminalise** later rungs in the data (Batch 1), not only in the UI.
- A reject must **stop erasing** `returned_at` / `returned_step_sequence` (Batch 1).
- The four dead statuses are **not** implemented speculatively. Closure/settlement is a business
  decision (§7) and is isolated so it blocks nothing.

## 3. Event architecture

`marketing_request_events` is live and append-only. Columns already carry: `request_id`,
`request_code`, `kind`, `actor_hr_id`, `occurred_at`, `recorded_at`, `from_status`, `to_status`,
`step_sequence`, `step_name`, `note`, `payload`.

Kinds captured today: `request_created`, `request_submitted`, `request_status_changed`,
`request_value_changed`, `request_deleted`, `step_opened`, `step_decided`, `step_commented`.

**Deliberately not added:** event kinds for lifecycle stages Phoenix does not implement
(settlement verified, closure). Inventing them would produce a timeline that lies.

`actor_hr_id` is best-effort and nullable — **NULL means "not recorded", never "system"**, and the
UI must render it that way. Backfilled rows carry `payload->>'backfilled' = 'true'` so a derived
event is never mistaken for a captured one.

## 4. Approval behaviour

Self-approval is refused at three layers (live). Remaining:

- later rungs terminalise on reject (Batch 1)
- comments append rather than overwrite (Batch 2)
- the detail page owns the approval experience, so no separate pseudo-detail screen is duplicated

## 5. Attachments

`marketing_evidence_files` holds rows but no per-request surface lists them. The Case File already
tiers customer PII and evidence photos by viewer. An Attachments section is additive and must keep
that tiering.

## 6. Notification deep links

Already correct: `marketingRequestNotificationUrl` emits `/marketing-requests/<id>`, which now
renders. `?decision=` still redirects to the shell-correct decision page so Telegram one-tap keeps
working. **No change required.** The dead `?request=` inbox branch is removed when the work queue
lands.

## 7. Finance — implement only what exists

`marketing_request_finance_requirements`: **0 rows, all time.** The 6-state `invoice_status`
vocabulary has never been exercised. `executed_at` is NULL on every request; `closed_at` on every
request ever created.

Therefore: surface what is real (requested amount, the `finance_execution` rung, transfer-proof
upload, evidence) and **mark settlement/closure explicitly as not applicable** rather than rendering
an empty section that implies data is missing. Whether the module should have a settlement lifecycle
at all is the one genuine business question, and it is isolated here.

## 8. Role behaviour

Per `PERSONA_MATRIX.md`. The work queue is role-aware: a Medical Rep never sees the Finance queue,
a Finance Manager never sees validation/bulk-upload. No role is routed through pages irrelevant to it.

## 9. Database migrations

| Batch | Migration | Risk |
| --- | --- | --- |
| 1 | `phx_decide_marketing_request_step` — terminalise later rungs, stop NULLing `returned_at` | Medium — the single write path for every decision |
| 2 | none (events table already captures `step_commented`) | — |

Every migration is applied to **staging first** and proven there. Production apply is prepared and
documented, and executed only on explicit owner approval, **before** any merge — the Railway deploy
applies no migrations.

## 10. Testing strategy

Every behaviour change ships with a test that is **proved to bite**: the fix is broken and the new
test's own headline assertion is confirmed to be the one that fires. Source-text assertions are
scoped to the function they describe — an unscoped regex passes against unrelated code and has
already produced three false-green assertions in this rebuild.

Plus the mandatory browser and mobile flows at 375 / 390 / 430.

## 11. Rollback

- **Batch 1** — the RPC is `create or replace`; the previous body is recorded verbatim in the
  migration header, so rollback is a single replace. Data written under the new behaviour
  (`skipped` rungs, preserved `returned_at`) is strictly more information than before and needs no
  reversal.
- **UI batches** — additive components behind the existing route; revert the commit.
- **No batch drops a column, a table, or a row.**

---

## Execution order

1. **Batch 1** — reject terminalises later rungs, stops erasing the return *(data-layer truth)*
2. **Batch 2** — comments stop destroying history
3. **Batch 3** — real timeline + tracking summary on the detail page
4. **Batch 4** — work queue with Needs My Action
5. **Batch 5** — browser + mobile E2E at 375 / 390 / 430

Progress is logged per batch in `MARKETING_REQUESTS_REBUILD_LOG.md` in this folder, written
**during** the work.
