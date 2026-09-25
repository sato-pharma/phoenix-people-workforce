---
name: crm-live-departed-agent-exclusion
description: "CRM read door now hides departed reps via live employment-status UNION static list; PR"
metadata: 
  node_type: memory
  type: project
  originSessionId: 73df30ed-e74a-4043-a596-ccd9bc11c371
---

Follow-up to [[resignation-employee-leak-audit-2026-07-18]]. The CRM read door (`src/lib/crm/reads.ts`) used to hide agents ONLY via the hand-maintained static `CRM_RESIGNED_AGENT_CRM_IDS` list. PR #1153 (`codex/crm-live-status-exclusion`, worktree `_wt-crm-live-exclusion`) adds a **live employment-status signal UNIONed with the static list** — `getEffectiveExcludedAgentCrmIds()` / `getEffectiveExcludedInList()` = static ∪ (agents whose sync-resolved `agent_hr_id` → employee with `employment_status ∉ {active, on_leave}`). Threaded through master.ts, rep-day.ts, admin.ts; single-source-door guardrail preserved ([[crm-single-source-door-guardrail]]).

**Key verification facts (read-only prod ozucdzovmcqvepbozvqf, 2026-07-18):**
- Static list is NOT replaceable: **77 of 79 static ids resolve to NO employee** — they're CRM territory/bucket placeholders (`"( Bani Sweif / E )"`, `"Others ( Eagles DM )"`). A pure status join catches only 1/79. Static list stays the permanent floor.
- The live join's real value: **18 departed reps were leaking** (agent_hr_id → resigned/terminated employee, but agent_crm_id never hand-added). Now auto-hidden: `1265,1391,1399,1400,1405,1412,1413,1438,1465,1467,1481,1485,1490,1495,1498,1499,1502,1536`.
- **Removed crm_id 1477** from static: reused CRM slot now → ACTIVE employee B-164 (Nasr City / P); was wrongly hiding an active rep.

**Design gotchas (don't regress):**
- Key the live exclusion on `agent_crm_id` (never null), NOT `agent_hr_id` — the mirror's agent_hr_id is frequently NULL and a naive PostgREST `.not("agent_hr_id","in",...)` drops all NULL rows (all the placeholder visits).
- Derive the departed set from the **visits mirror's stored agent_hr_id** (sync's full override→crm_id→username waterfall), NOT an `employees.crm_id` shortcut — `1400`/B-101 resolves only via the username tier (no numeric crm_id, not an override). Visits alone are complete (every departed agent with check-ins also has visits).
- `employees.crm_id` is TEXT, `ireports360_visits.agent_crm_id` is BIGINT (cast on join). Terminal = `!isActiveLifecycleStatus` (now exported from employee-directory.ts); active set = `{active, on_leave}`.
- Cached ~5min, fail-safe: any error computing the live set degrades to the static list alone (over-hide, never under-hide).

**Status:** MERGED to main 2026-07-18T16:16Z (commit range ending 49f6f4f6, PR #1153 merged by Phoenix-HR right after #1151) — check:harden was green (403 test files) pre-merge. Live in prod via the auto-deploy pipeline (europe-west3 no-traffic→smoke→promote passed; phoenix-hr.satopharma.com returns 200). Owner approved the "all non-active" scope + hide-18/un-exclude-1477 decisions before merging. Worktree `_wt-crm-live-exclusion` + local branch CLEANED 2026-07-18; remote branch auto-deleted on merge.
