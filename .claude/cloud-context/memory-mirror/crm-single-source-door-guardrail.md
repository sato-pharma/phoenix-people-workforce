---
name: crm-single-source-door-guardrail
description: "Every module reads iReports360 CRM data through the ONE door src/lib/crm/reads.ts — no file outside src/lib/crm/ may run its own ireports360_* query, and tests/crm-single-source.test.ts fails the build if one does. Reusable lessons from enforcing it: CI's pull_request checkout tests the branch MERGED WITH MAIN, so a consumer main added surfaces in CI even when your branch is green locally; and ripgrep/Grep silently SKIPS files it flags binary, so a grep sweep can't prove 'no consumers left' — the node-readFileSync test is the source of truth."
metadata:
  node_type: memory
  type: project
  originSessionId: 76130c78-51c5-4485-975a-3e70161783c6
  modified: 2026-09-26T00:16:58.994Z
---

## The rule

Every module reads iReports360 CRM data (visits, check-ins, double-visits) through the single door
**`src/lib/crm/reads.ts`** — **no file outside `src/lib/crm/` runs its own `ireports360_*` query.**
Shipped and live since 2026-07-17.

## The lock is a real test, not just discipline

`tests/crm-single-source.test.ts` (`runCrmSingleSourceTests`, wired into `tests/run-tests.ts`) walks
every `.ts/.tsx` under `src/` and `app/` and **fails the build if any file outside `src/lib/crm/`
contains a `.from(<mirror>)`** — the string literal OR any mirror-table const (`visitsTable`,
`DV_SOURCE_TABLE`, `VISITS_MIRROR_TABLE`, `CRM_VISITS_TABLE`, …). It also asserts `reads.ts` still
exposes the shared primitives. So a new consumer is caught mechanically, not by review.

## The door's read primitives — call these, never query the mirror

`queryVisits`, `queryVisitsLimited`, `queryVisitsPage` (paginated + count), `scanVisitsForRange`
(offset scan preserving FWC's covering-index perf), `queryCheckins`, `getDoubleVisitRows`,
`getVisitAgentNames`, plus filters `agentHrIds` / `agentHrIdILike` / `doubleHrIds` / `visitTypes` /
`doubleOnly` / `requireAgentHrId` / `requireDoubleHrId`. **All of them bake in the resigned/owner
exclusion** ([[crm-resigned-agents-exclusion-list]] via `CRM_RESIGNED_IN_LIST`). The ONE exception is
**`getMappedAgentHrIds`** — a presence check with NO resigned-exclusion, used only by the probation
`crmUnmapped` badge; don't reuse it where the exclusion matters.

The door also carries the **casing-safe hr-id match** (`expandHrIdFilterValues` via `hrIdLookupKeys`):
CRM ids are stored lowercased while `app_auth_users`/`employees` hold UPPERCASE, so a raw `.in()` on
lowercased ids is a silent no-op — always expand through `hrIdLookupKeys`.

## Reusable lessons from enforcing it

- 🔴 **CI tests the MERGE, not the branch head.** The `pull_request` event checks out
  `refs/pull/N/merge` (your branch merged into main), so a green LOCAL run on a stale branch can still
  fail CI when **main added a new CRM consumer while your branch was in flight**. Fix pattern:
  `git merge origin/main`, migrate the newly surfaced consumer through the door, re-run the guardrail on
  the merged tree. On a long-lived branch, expect this.
- 🔴 **ripgrep / the Grep tool SILENTLY SKIPS files it flags as binary**, so a grep-based "no consumers
  left" sweep has a blind spot the node `readFileSync` guardrail does not. Don't trust a grep-only sweep
  to prove a migration is complete — the test is the source of truth
  ([[localappdata-temp-is-live-tool-state]] on tool blind spots).

## Ground-truth CRM data facts (used all through the door)

- **iReports360 timestamps are Cairo wall-clock stored as `+00`** — read them as-is with `timeZone: UTC`,
  and **never re-convert through `Africa/Cairo`** (that double-shifts them).
- **`crm_save_date` is the ONLY real per-visit time signal.** `visit_date_time` is a midnight
  placeholder (0 of ~102,873 rows carry a real time), so anchor check-in matching and any
  ordering/tie-break on `crm_save_date`, not `visit_date_time`.
- **Canonical double-visit predicate:** `double_crm_id ≠ 0 AND visit_type IN (0, -8)`. Any code counting
  DVs off a bare `double_hr_id` on any visit_type both inflates and drops unmapped-partner DVs.
- **Check-in ↔ visit match** (`src/lib/crm/checkin-match.ts`, the one canonical matcher): same agent +
  same real `contact_crm_id` + same Cairo day, tie-break `crm_save_date`.

## Parallel-session recovery

Shipping this hit the shared-checkout hazard — the primary was on another task's branch with mixed
uncommitted work. Safe recovery: patch out ONLY your own files, apply in a fresh worktree off
`origin/main`, cherry-pick, verify, PR — never commit the other session's files
([[shared-checkout-branch-switched-midsession]]). CI runs on pnpm ([[pnpm-migration-2026-07-17]]);
local `npm run test` loads `.env.local`, which points at PRODUCTION.
