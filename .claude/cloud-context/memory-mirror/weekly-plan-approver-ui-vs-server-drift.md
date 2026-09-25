---
name: weekly-plan-approver-ui-vs-server-drift
description: "Weekly-plan workspace offered Super Admin approve buttons that always 403'd, and blocked CEO/Manager from the comment thread built for them. Fixed in PR #1589. The revise-collision needs a migration and is NOT fixed."
metadata: 
  node_type: memory
  type: project
  originSessionId: e0491122-d75a-469e-8531-3c35cc29cb82
  modified: 2026-08-01T16:16:33.060Z
---

Three defects found by [[module-audit-2026-08-01-status]], all independently re-verified against
`main` before touching anything. **Two fixed in PR #1589** (`2109f5ef`, branch
`codex/weekly-plan-comment-and-sa-queues`, worktree `_wt-weekly-plan-gates`); the third is scoped
out and still open.

## Fixed

1. **Super Admin decision queues rendered guaranteed-403 buttons.** `plans-workspace.tsx` fed
   `isSuperAdminReviewer` into the manager / edit-request / CEO queues under a comment claiming it
   "mirrors the server guards". It mirrors nothing: `assertManagerReviewer` admits only the
   assigned direct manager (CEO only when `manager_hr_id` is null) and `assertCeoReviewer` is
   CEO-only. **The owner-locked four-gate model is CORRECT server-side — the UI was the liar.**
   The Action Center already got this right (`resolveApproverPlanStage` → null for SA). SA's real
   step is HR acknowledgement, a separate queue, untouched.
2. **CEO and Manager could not post in the plan conversation.** `addPlanComment` asserted
   `weekly_plans:update`; CEO is `["read","approve","export"]` and Manager is `["read","approve"]`.
   The composer renders unconditionally and `listPlanComments` hardcodes `canComment: true`, so
   they typed and got Forbidden on Send. Gate is now `read`; `canViewPlan` is the real
   authorization, matching the route's own doc comment.

## 🔴 NOT fixed — the revise collision needs a migration

Revising an approved plan still dies on `employee_plan_headers_active_period_uidx`. The status enum
has **no superseded state** and the index excludes only `draft`/`cancelled`/`manager_rejected`/
`ceo_rejected`. **Do NOT demote an approved parent to `cancelled`** — that erases the fact it was
ever approved. The real fix is: new terminal status + index-predicate migration + demote the parent
inside the submit RPC atomically (the revision header is currently created OUTSIDE the RPC, which
is why each failed retry orphans another draft). Needs its own approval and PR.

## Traps this cost (both were MY test bugs, not code bugs)

- A `doesNotMatch(/Super Admin/)` assertion on `assertManagerReviewer` **failed on correct code**,
  because the guard's own comments say "Super Admin has NO standing bypass here". Match the bypass
  SHAPE (`role === "Super Admin"`, `scope === "system"`), never the words.
- Slicing between two functions with `indexOf("async function assertCeoReviewer")` returned **-1**
  because that function is NOT async — and `slice(start, -1)` silently swallowed the rest of the
  file, so the test matched text from unrelated code. Always assert `end > start` before slicing.

Related: [[weekly-plan-four-gates-rm-dsm]] (the owner-locked approver model this restores fidelity
to) · [[prove-it-fails-verify-which-assertion-fired]].
