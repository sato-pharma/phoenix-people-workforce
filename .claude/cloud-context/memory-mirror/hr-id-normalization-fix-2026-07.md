---
name: hr-id-normalization-fix-2026-07
description: "HR_ID equality checks that skip the legacy alias table (aaa->aa) were fixed across 4 files in branch codex/hr-id-normalization-fix (2026-07-03); pattern recurs — most recently 2026-07-11 in resolutions.ts (Map key mismatch)."
metadata: 
  node_type: memory
  type: project
  originSessionId: 80e168f3-3a80-419c-8d31-96529c2353a8
---

An audit (confirmed by 2 independent sub-agents) found several HR_ID equality checks using
local uppercase/lowercase-only normalization instead of `canonicalHrIdKey`/`hrIdsMatch` from
`src/lib/hr-id.ts`, missing the legacy alias table (`aaa` -> `aa`, defined in
`src/lib/hr-id.ts`). Risk was explicitly low: false-denial/miscategorization only (fails
closed) — e.g. self-manager validation bypass, duplicate-detection miss, employee-not-found
on a record that does exist. Not a privilege-escalation vector.

Fixed on 2026-07-03 in an isolated worktree (`F:/Phoenix Workforce/_wt-hr-id-normalization`,
branch `codex/hr-id-normalization-fix`, based on fresh `origin/main`) because another Claude
Code session was active in the primary worktree at the time — see
[[parallel-session-swarm-hazard]].

**Files fixed:**
- `src/lib/imports/employee-validator.ts` — duplicate-HR_ID detection, self-manager check,
  seat-owner/CRM-owner mismatch checks, manager-not-found check, and the terminal/protected/
  existing-employee HR_ID Set lookups in `validateEmployeeImportRows` all now key/compare via
  `canonicalHrIdKey`/`hrIdsMatch` (display strings for duplicate messages preserved via a
  canonical-key -> first-seen-raw-value map, so user-facing casing didn't change).
- `src/lib/sales/employees.ts` — introduced a dedicated `hrIdKey()` wrapper (kept the existing
  generic `normalize()` for non-HR_ID text like job_title/status/crm_id/crm_username — do NOT
  collapse these into one function, they serve different purposes and canonicalHrIdKey's alias
  table would wrongly apply to non-HR_ID strings).
- `src/lib/workforce-classification.ts` — only `isApprovedOthersSalesBucket`'s HR_ID compare
  was in scope (the file's `employeeByHrId`/`normalizeKey` indexing in
  `buildSalesOwnershipContext` is a separate, higher-blast-radius structure shared with
  crmId/lookupKey/name maps — intentionally NOT touched, would need its own follow-up).
- `src/lib/resignations/service.ts` — already imported the *correct* canonical `normalizeHrId`
  from `@/lib/auth/permissions` (it wraps `canonicalHrIdKey`) but used it inconsistently; fixed
  `resolveSubmittedByHrId`, the `employeesByHrId` dashboard map, `createResignation`,
  `resignEmployeeAndOpenVacancy`, `loadHistoricalResignedEmployeeByHrId` (DB `.eq()` query key),
  and the scope-check employee lookup in `runResignationWorkflow`.

**Test note:** `tests/resignation-workflow-scope-check.test.ts` does a source-regex assertion
pinned to the literal `item.hrId === row.employee_hr_id` comparison — had to update the regex
to accept `hrIdsMatch(item.hrId, row.employee_hr_id)` while preserving the test's actual intent
(lookup must key off `row.employee_hr_id`). Several other tests in this codebase grep source
strings this way (see [[coaching-analytics-shared-dashboard]]) — expect this class of breakage
whenever refactoring a comparison a source-regex test pins to.

Committed + pushed + PR opened + merged same day, all with explicit per-step user approval —
see [[feedback-auto-git-workflow]]: [PR #738](https://github.com/Phoenix-HR/phoenix-people-workforce/pull/738)
(codex/hr-id-normalization-fix -> main), squash-merged 2026-07-03T05:45:15Z, merge commit
3ad65e30. New production deploy verified Ready and serving at
https://phoenix-workforce.vercel.app.

**Follow-up same day:** `src/lib/marketing-requests/service.ts` had its own separate local
`normalizeHrId` (lowercase-only, no alias), used ~30 times internally for marketing scope
checks/approval-chain routing/requester-actor equality. Confirmed nothing outside the file
imports it, so the fix was a 1-line change: route the function body through `canonicalHrIdKey`
instead of patching each call site. Worktree `F:/Phoenix Workforce/_wt-marketing-hrid-fix`,
branch `codex/marketing-hrid-normalization-fix`,
[PR #741](https://github.com/Phoenix-HR/phoenix-people-workforce/pull/741) — squash-merged
2026-07-03T06:20:35Z, merge commit 218246b7, new production deploy verified Ready and serving.
This file already had a *separate*, already-fixed storage-dialect issue
(`resolveStoredEmployeeHrId`, FK-casing bug, regression-tested in
`tests/marketing-approver-hrid-casing.test.ts`) — don't confuse the two dialects if revisiting.

**Third recurrence, 2026-07-11, new variant (Map key mismatch, not a DB `.eq()`):**
[[system-issues-dashboard-gcp-supabase]]'s resolve-tracking feature
(`src/lib/error-monitor/resolutions.ts`, `ResolutionIndex`) built a `Map<string, number>`
keyed by raw `hr_id` on insert (already canonical-lowercase from `resolveIssue`'s
`canonicalHrIdKey(input.hrId)`) but looked it up with the *display*-form HR ID
(`canonicalHrIdForDisplay`, uppercase) passed straight through with no re-canonicalization —
classic silent-miss, not a crash: every lookup returned `undefined` so every issue looked
"active" even after being resolved. Caught only by live staging testing (resolve HR ID `A-8`,
then re-fetch and see the status field), not by code review or typecheck — this class of bug
is invisible without actually reading data back after a write. Fixed by canonicalizing the
key on *both* the map-build side and the lookup-call side. **Takeaway: any new
`Map`/object keyed by HR_ID needs the same `canonicalHrIdKey` scrutiny as a DB `.eq()` —
it's not just a query-comparison pattern, it's any place two differently-cased/aliased HR_ID
strings need to compare equal.**
