---
name: health-fixation-2026-06-15
description: "Permanent fixation of the 2026-06-15 repo/Vercel/Supabase health-check findings — branch protection now on main, advisor baseline doc, B+D prod migrations applied"
metadata: 
  node_type: memory
  type: project
  originSessionId: 3a2843a9-c837-47ea-9941-37f2409c91cd
---

Health-check fixation shipped as PR #199 (branch `codex/health-fixation-20260615`), 2026-06-15.

**`main` is now BRANCH-PROTECTED** — requires the `validate` CI job (lint+typecheck+test+build) to pass before merge; `enforce_admins=false` so the owner can still direct-push (deliberate override). First protection ever on this repo. If a push/merge is blocked, that's why.

**Applied to prod (verified):**
- `pin_attendance_punch_search_path` — pinned `search_path=public, pg_temp` on `phx_insert_attendance_raw_punch` → cleared `function_search_path_mutable`.
- `consolidate_geo_brick_select_policies` — collapsed overlapping `authenticated` SELECT policies on brick_reference_imports/_rows, geo_bricks/_locations/_trip_routes into one (read scope OR `phx_can_manage_geo()`), writes re-scoped to INSERT/UPDATE/DELETE. Behaviour-preserving → cleared all `multiple_permissive_policies` (was 7→0; payroll/salary pair already gone).

**New guardrails / docs:** `tests/postgrest-array-filter-guard.test.ts` (fails on `.cs/.cd/.ov.[` JSON-bracket array filters anywhere in src/, the `["A-12"]` malformed-array class); `docs/security/supabase-advisor-baseline.md` (single triage list of accepted by-design advisors — extends [[db-data-model-hardening-2026-06-15]]); `scripts/prune-stale-branches.ps1` (backup-then-delete, dry-run default, ASCII-only for PS 5.1).

**Don't re-do:** migration-history version drift (MCP `apply_migration` auto-timestamps ≠ repo filenames) is handled by the existing `supabase migration repair` / phase33 pipeline — NEVER hand-rename committed migration files. Origin branch sprawl already self-cleans (auto-delete-on-merge; was 5 branches, not 94).

**MERGED** to main 2026-06-15 as squash commit `964368f2` (PR #199) + deployed to prod; fixation branch + worktree cleaned up. Note: the geo/brick consolidation migration is GUARDED (no-ops on fresh builds where the prod-only geo subsystem is absent) because it broke the Supabase Preview check — the geo/brick tables + `private.phx_can_manage_geo()` are prod-only and NOT in repo migrations (real drift; full baseline capture is the open follow-up).

**Owner follow-ups (not done):** PR #129 expense fields actually landed separately as PR #196 (rescued) + #197 (payroll RLS) + #198 — check if #129 is now redundant. 326 unused-index review deferred. Capture the geo/brick subsystem (tables + helpers) into repo migrations so a from-scratch rebuild is complete.
