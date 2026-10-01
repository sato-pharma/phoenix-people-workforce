---
name: excuse-decision-race-condition-fix
description: "TOCTOU race-condition bug class (read-check-write with no DB status guard) found in excuses service; established fix pattern + which domains are known-fixed vs unchecked."
metadata: 
  node_type: memory
  type: project
  originSessionId: cdb28956-6e75-4804-919a-d6bba1485690
---

A security audit finding (confirmed independently by 2 review passes) flagged a live
TOCTOU race in `src/lib/excuses/service.ts`: `decideExcuseRequestByToken`,
`decideExcuseRequestAsManager`, and `resubmitExcuseRequest` (found during investigation,
not in the original report) all read a request's `status`, checked it in JS, then issued
an `UPDATE` filtered only on `id` — no DB-level status guard. Two concurrent decisions
(double-click, or a token-link decision racing an in-app one) could both pass the JS
check and the second write would silently overwrite the first's decision/audit trail,
firing duplicate/contradictory notifications.

**Established fix pattern (already proven in this codebase before this fix):**
`src/lib/vacation/service.ts` (`recordVacationApprovalStepDecision`) — add
`.eq("status", "<expected>")` to the `UPDATE`'s `WHERE` clause (DB-level compare-and-swap),
switch `.single()` → `.maybeSingle()`, then `if (!data) throw conflictError(...)`
(`conflictError` from `src/lib/http/api-errors.ts:29`, → HTTP 409, `ApiError extends Error`
so it's compatible with every domain's existing `errorMessage()`/`isForbiddenError()` helpers).
`src/lib/marketing-requests/service.ts` already reuses this same helper for its own
"already decided" race.

**Fixed so far (as of 2026-07-02):**
- Vacation approval steps — pre-existing, already shipped.
- Marketing-requests decision — pre-existing, already shipped (uses `conflictError` directly).
- Outstation — PR #681 ("add update race guard"), merged to `main` just before this session
  started; same bug class, different session/finding, not yet read in detail.
- Excuses (`decideExcuseRequestByToken`, `decideExcuseRequestAsManager`,
  `resubmitExcuseRequest`) — PR #685 (`codex/excuse-decision-race-fix`), this session,
  2026-07-02. Followed the exact vacation pattern; added 8 source-regex test assertions to
  `tests/excuses.test.ts` (this file's convention: read the whole service file into a string,
  `assert.match`/`assert.doesNotMatch` regex against it — no mocked-Supabase runtime tests
  exist here). API routes deliberately left unchanged (still return 400, not 409, for this
  conflict) — that's an explicitly deferred, separate follow-up, not done in #685.

**Not yet checked for this same bug class:** resignations, probation, contracts, offers,
and any other `src/lib/<domain>/service.ts` with a decision/approval-step function that
does read-status-in-JS then `.update(...).eq("id", ...).single()` with no status guard in
the `WHERE` clause. Worth a targeted grep (`.update(` near `.eq("id",` without a matching
`.eq("status",`) if handed a similar finding in the future.

**Why this matters:** if a future session gets handed another race-condition finding in an
approval/decision flow, this is the reusable fix recipe and the reference implementation —
don't re-derive it, and check whether the domain already uses `conflictError` before
introducing a new error convention.

**How to apply:** when fixing this bug class in a new domain, grep that domain's
`service.ts` for `.update(` + `.eq("id",` + `.single()` combos, confirm what status value
each guards on from the preceding JS pre-check, and apply the same four-part fix (status-eq
guard, `maybeSingle`, conflict throw, matching source-regex test additions) — see
[[sales-permission-security-audit-2026-07]] for the unrelated-but-similar-process
permission-matrix audit (different bug class, same "audit hands you one finding at a time,
verify no duplicate work in flight" workflow).
