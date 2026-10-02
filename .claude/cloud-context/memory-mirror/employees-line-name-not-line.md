---
name: employees-line-name-not-line
description: "OUTDATED IN PART (contradiction sweep 2026-10-02) — current: employees.line_name is NULL for every production row — the product line must be resolved from line_id via the lines table, never read from the text column (see `employees-line-name-column-is-null-in-production`). Older text follows: Production employees table has line_id + line_name; there is NO `line` column — selecting `line` throws and breaks the feature."
metadata: 
  node_type: memory
  type: project
  originSessionId: cb51c52d-7ae1-4f12-a538-42dbfc306a24
---

In the **production** Supabase (`ozucdzovmcqvepbozvqf`), `public.employees` has `line_id` (bigint) and `line_name` (text). There is **no `line` column**. Any Supabase `.select(... "line" ...)` returns a "column does not exist" error.

**Why it matters:** these errors are plain objects, not `Error` instances, so callers that do `error instanceof Error ? error.message : "<generic>"` show a misleading generic fallback (e.g. employee Deductions page showed "Unable to load published deductions"). This is the dual-project schema divergence — see [[supabase-dual-project-schema]].

**How to apply:** when querying employee line, use `line_name` (or the `lines(name)` FK join), never `line`.

Bit two modules; both fixed in ONE minimal PR off main: **PR #44 — MERGED & LIVE in production** (squash `505d7194`; branch `fix/deductions-portal-line-name` was 2 files / 9 lines, typecheck+lint green, prod schema verified). Vercel prod deploy READY 2026-06-07; `phoenix-workforce.vercel.app` healthy. No migration needed — deductions schema already in prod (`20260607012006`).
- `src/lib/deductions-governance/service.ts` `listPublishedDeductionsForPortal` (the "Unable to load published deductions" report bug)
- `src/lib/notifications/email.ts` — `EmailContactRow`, 3 employee selects, `employeeLine()` fallback (the `lines(name)` FK join is unchanged)

History: earlier PR #42 (whole-feature, stale base) was CLOSED — it would have reverted unrelated main work. Stale branches `codex/deductions-governance-portal` + `codex/deductions-governance-completion` (both superseded by main) were flagged for deletion but the remote-delete was blocked pending explicit owner authorization.
