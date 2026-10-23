---
name: re-running-the-system-audit-sweep-does-not-buzz-his-phone
description: "The system-audit sweep can be re-run on production to verify a detector fix without sending the owner a second notice — the daily message is idempotent per Cairo day, so a repeat run's deliveries all come back skipped; the route has no detector filter and no skip-message flag, and the proof to read afterwards is system_audit_detector_runs."
metadata:
  node_type: memory
  type: project
  originSessionId: e00847ef-5eba-4ce7-ad71-9818ac7186de
  modified: 2026-10-23T08:40:09.573Z
---

`app/api/cron/system-audit-sweep/route.ts` takes **no query options at all** — no detector filter, no
dry run, no "skip the message". GET and POST both run all six detectors and then the daily message,
under a 300 s `maxDuration`. So "just run the one detector" is not available, and a session that
wants to verify a `visit_lifecycle` fix has to run the whole sweep.

🔴 **That is safe: a second sweep the same Cairo day sends the owner NOTHING.**
`src/lib/system-audit/daily-message.ts` counts "once a day" in **Cairo calendar days** and stops a
repeat behind an idempotency key, so every delivery comes back skipped. Measured on production
23 Oct 2026 11:37 Cairo, a second sweep after the morning's: `"dailyMessage": { "sent": false,
"candidates": 3, "delivered": 0, "reason": "no delivery reached anyone" }` — three real new findings,
and his phone stayed quiet. Two further guards make it quieter still: `system_audit_alert_candidates`
returns only issues that are NEW or newly shared and the previous run marked what it told him, and
nothing new means nothing is sent at all (never a daily "all clear").

**How to run it** — through Railway so `CRON_SECRET` is never printed, stored or put on a command
line, and **GET, because POST through the public domain answers 403 `csrf_blocked`**:

```
railway run --service phoenix-people-workforce -- node <script>.mjs
```

with the script reading `process.env.CRON_SECRET` and calling
`https://phoenix-hr.satopharma.com/api/cron/system-audit-sweep` with `Authorization: Bearer …`.
It takes about a minute (56 s measured). On Windows the node process may print
`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` **after** the complete JSON — libuv teardown
noise, not a failure.

**Read the proof in the database, not only in the HTTP body** —
`select detector, status, scanned, inserted, error from system_audit_detector_runs where detector =
'…' order by started_at desc`. On 23 Oct that table held the before and after side by side: the
10:56 Cairo run `errored` / scanned 0 / `column phoenix_crm_visit_recordings.id does not exist`, and
the 11:37 run `ok` / scanned 83 / inserted 3. **A detector that errors leaves the whole sweep
`status: "partial"` but still answers HTTP 200**, so the status field is what to read, never the code.

🔴 **`system_audit_issues` has no `detector` column** — the family lives in `family`
(`visit_lifecycle`, `app_error`, `sync_run`). Its 16 columns are `id, signature_key, family,
error_code, title, status, root_cause_level, root_cause, root_cause_evidence, first_seen_at,
last_seen_at, alerted_at, alerted_people, alerted_status, created_at, updated_at`; the per-event
detail, the employee names and the evidence are in `system_audit_occurrences`.

Related: [[five-sessions-fixed-one-production-error-in-parallel]],
[[env-local-lost-cron-secret-realign-from-railway]].
