---
name: payroll-mutations-were-unaudited-until-2026-08-21
description: "Importing, replacing or deleting a salary batch wrote NO audit row at all until PR #2241 — only workflow status transitions were ever logged"
metadata: 
  node_type: memory
  type: project
  originSessionId: 26968de2-24de-4b16-a339-4065a48eba87
  modified: 2026-08-20T23:56:52.806Z
---

Measured on production Supabase (`ozucdzovmcqvepbozvqf`) on **2026-08-21**: `audit_logs` held
**15 `payroll_batch` rows in total**, newest **2026-07-13**, and every single one came from
`runPayrollWorkflow` — a status transition. For scale, `vacation_request` logged **340 rows in
30 days** from 10 call sites.

So `createSalaryBatch`, `replaceSalaryBatch` and `deleteSalaryBatch` each wrote nothing.
`deleteSalaryBatch` called `phx_delete_salary_batch` and returned: a month of payroll could be
destroyed with no record of who did it.

**Why:** the three mutation paths were built before the audit helpers were the house idiom, and
nothing failed loudly — `audit_logs` simply stayed empty, which reads exactly like "no one has
deleted a batch" rather than "we do not know who did."

**How to apply:** PR #2241 (squash `ce7f2853`) added `writeRequiredAuditLog` to all three and is
**LIVE on production since 2026-08-21 02:50 Cairo**; `tests/payroll-mutation-audit.test.ts` pins
them. Proven end to end on STAGING (`cifwmndunmlxjhyjugxa`) by running the real service functions:
import → replace → delete on a throwaway 12/2099 batch took `payroll_batch` audit rows 15 → 18,
each naming its actor. The delete's `old_values` carried the **post-replace** filename, which is
what proves the before-image is read at the right moment. The three proof rows were then deleted
at the owner's request, so **both databases sit at 15 `payroll_batch` rows, newest 2026-07-13** —
that is the baseline the first genuine post-deploy mutation will move. Two things to keep intact:

- The delete reads its before-image **before** the RPC — the RPC removes the row and its
  `salary_records`, so a read placed after it always returns `null`. The test enforces the order.
- The before-image read is wrapped in try/catch and the delete proceeds if it fails. Refusing an
  authorised delete because a logging read failed would turn a logging problem into an outage.
  The audit row then records `"Batch row could not be read before deletion."`

Note `writeRequiredAuditLog` **throws** `AuditPersistenceError`. On the two import paths it fires
after the batch has already committed, so a failed audit write surfaces as an error over data that
did land. That is the deliberate "required" semantic vacations already run on.

Do not mistake an `access-registry.ts` entry for this fix — see
[[access-registry-is-declarative-and-writes-no-audit-row]].

**VERIFIED 2026-08-28 - the code is fixed, and the fix has NEVER RUN in production.**
`src/lib/payroll/service.ts` now calls `writeRequiredAuditLog` from all three mutation paths
(lines 1393, 1445, 1544 on `main`), so the gap is closed in code. But production `audit_logs`
still holds **exactly 15 `payroll_batch` rows, newest 2026-07-13, and 0 since the fix merged** -
no batch has been imported, replaced or deleted since, so not one row has been written by the new
path. **A merged fix on a path nobody has exercised is untested, not proven.** The next batch
import is the first real test of it; check for an audit row afterwards rather than assuming.
This also means the count above cannot be used to tell "the fix works" from "the fix is broken" -
both look like 15 rows until someone touches a batch.
