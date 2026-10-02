---
name: agents-md-stale-staging-ref
description: "OUTDATED IN PART (contradiction sweep 2026-10-02) — current: supabase-staging's empty project list was a WRONG-ACCOUNT token; it now runs pinned with ?project_ref=cifwmndunmlxjhyjugxa, takes no project_id at all, and is called directly (see `supabase-staging-mcp-server-sees-zero-projects`). Older text follows: Canonical staging-Supabase-ref memory — staging is cifwmndunmlxjhyjugxa, izhmxvgiktiafqusolot is DEAD; never trust a ref from prose, resolve with list_projects; both MCP servers see both projects"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 046c2623-cbf3-474b-84df-74cf5e16d2d3
  modified: 2026-07-31T16:23:54.999Z
---

**FIXED AND MERGED** — PR #1397, `6f99eb13` on main, 2026-07-27. `main`'s AGENTS.md now carries the
correct ref. Kept as a memory because the *lesson* outlives the fix: never trust a ref from prose.

`AGENTS.md` § **Supabase And Data Safety** said: *"Staging is `izhmxvgiktiafqusolot`; production is
`ozucdzovmcqvepbozvqf`."* The staging half is **wrong and dangerous** — that project does not exist
on the account at all (confirmed via `list_projects` 2026-07-27; only `cifwmndunmlxjhyjugxa` and
`ozucdzovmcqvepbozvqf` are returned).

The correct staging ref is **`cifwmndunmlxjhyjugxa`** (`Phoenix-HR-Staging`, eu-central-1, created
2026-07-11), exactly as AGENTS.md § **Stable Environment Facts** states. The two sections of the
same file contradict each other.

**Why:** that Data Safety line is the one an agent reads immediately before a database mutation, as
the "print and verify the exact project ref" safety step. Trusting it means the verification step
confirms a dead ref — and the natural recovery ("staging must be the other one") points at
PRODUCTION.

**How to apply:** always resolve the ref with `list_projects` before any apply/mutation rather than
from AGENTS.md prose. Note both Supabase MCP servers (`supabase-staging` and `supabase-production`)
can see BOTH projects, so the `project_id` argument is the only thing separating staging from
production — the server name guarantees nothing.

## Backstory + two traps (merged 2026-07-31 from `staging-supabase-project-ref-corrected-2026-07-11`)

The current staging project was created 2026-07-11 when the owner said *"you are pointing to old one
… deep dive the system to get it"* — i.e. **don't ask him for the ref, go resolve it.** It was
seeded from a production snapshot (full schema, real-looking row counts), not a blank project. The
old `izhmxvgiktiafqusolot` was merely INACTIVE/paused then; by 2026-07-27 it was gone from the
account entirely.

⚠️ That 07-11 memory also recorded that `mcp__supabase-staging__*` could see **only** the dead
project and returned `MCP error -32600: You do not have permission` for the live one. **That is no
longer true** — both MCP servers now see both projects, which is exactly why the `project_id`
argument is the only real separator. Do not plan around the old org-scoping.

**AI-mode classifier note, still live and worth expecting:** inserting synthetic test rows into
`cifwmndunmlxjhyjugxa` got blocked by the auto-mode classifier *even after* the ref was fully
verified and the owner had approved applying a migration there — it reasoned the approval covered
"apply the migration" only, not an open-ended follow-up write, and treated the
`supabase-production`-named tool as suspicious regardless of `project_id`. Treat every additional
staging **write** beyond an explicitly approved migration as needing its own ask.

The Supabase CLI is a THIRD credential (this machine's own `supabase login`), useful for
cross-checking an MCP org scope. `supabase db push` / `migration list` need `SUPABASE_DB_PASSWORD`
and errored on this project with a `cli_login_postgres` role-provisioning bug — use MCP
`apply_migration` / `execute_sql` for DDL/DML instead.

Two other files still name the dead ref. `scripts/staging-safe-rebuild.ts` (`currentStagingRef`) is
**intentional** — a historical rebuild tool, its comment says so and `tests/staging-safe-rebuild.test.ts`
pins the string; do NOT "fix" it. `scripts/seed-vlookup-master.mjs` lines 16/28/29 was stale —
**fixed in PR #1398** (2026-07-27, branch `codex/fix-seed-vlookup-staging-ref`), which also had to fix
a shadowed-credential trap in the local env file: see [[staging-env-file-new-prefix-is-dead-project]].
See also [[prod-mcp-token-owns-staging-supabase]], [[sos-ims-ratio-storage]].
