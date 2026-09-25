---
name: supabase-staging-named-server-broken-2026-08-10
description: "RESOLVED 2026-09-12 by PR #3726 — the mcp__supabase-staging__* breakage first seen 2026-08-10 (list_projects empty, every call -32600) was NEVER the database or the server: SUPABASE_STAGING_TOKEN belonged to a DIFFERENT Supabase account holding no projects. It now runs on SUPABASE_PROD_TOKEN pinned with ?project_ref=cifwmndunmlxjhyjugxa. Do NOT route staging through mcp__supabase-production__* any more, and do not re-diagnose this"
metadata: 
  node_type: memory
  type: project
  originSessionId: 9a8c8f5c-a32c-477b-92aa-82c1c7e53cc9
  modified: 2026-09-11T22:04:08.388Z
---

🔴 **RESOLVED 2026-09-12 — PR #3726, merged as `d9697de8a`. Read this half first; everything below it
is the 2026-08-10 observation, kept as the dated record.**

**Root cause, measured:** `SUPABASE_STAGING_TOKEN` (sha256 fp `883d5882`, len 44) belongs to a
**different Supabase account**, whose single organization `whgmpfdyqzyspjrmkbix` holds **0 projects**
(`GET /v1/projects` → 200, count 0). So `list_projects` was correctly empty and every other call
correctly answered `-32600`. Nothing was ever wrong with the staging database, the MCP server, or the
deny list — the token simply pointed at the wrong account. **That old token is still valid in that
other account and should be revoked there.**

**The fix:** `.mcp.json`'s `supabase-staging` now uses `${SUPABASE_PROD_TOKEN}` with
`?project_ref=cifwmndunmlxjhyjugxa`. Scoping cuts the toolset 29 → 20, removes `list_projects` and
`create_project`, makes `execute_sql` take no `project_id`, and **refuses a passed production
`project_id` with a Zod `unrecognized_keys` error** — so the staging server now has no path to
production at all, which is stronger than the old arrangement where the `project_id` argument was the
only separation.

**How to apply now:** call `mcp__supabase-staging__*` directly with **no `project_id`** — passing one
is an error, not a safety habit. Do **not** route staging through `mcp__supabase-production__*` any
more, and do not re-open this diagnosis. `AGENTS.md` §2.1/§3/§8 were updated to match.
⚠ `${VAR}` in `.mcp.json` is expanded from the environment at **app start**, so the pinned server
only appears after a full quit-and-reopen of the Claude desktop app. See
[[supabase-staging-mcp-server-sees-zero-projects]] for the second sighting of the same fault.

---

Checked live 2026-08-10 while running a staging health check. `mcp__supabase-staging__list_projects`
returned `{"projects":[]}` and `mcp__supabase-staging__get_project(id: cifwmndunmlxjhyjugxa)` returned
`McpError -32600: You do not have permission to perform this action`. This is NOT the stale-process
symptom in [[supabase-mcp-and-cli-revoked-2026-08-02]] (that one shows zero `mcp__supabase-*` tools
appearing at all in a stale window) — here the tools loaded fine and answered, just empty/denied, in
a session started fresh this turn.

**Workaround, confirmed working end to end:** `mcp__supabase-production__list_projects` sees BOTH
projects (`cifwmndunmlxjhyjugxa` Phoenix-HR-Staging AND `ozucdzovmcqvepbozvqf` Phoenix HR, both
`ACTIVE_HEALTHY`), and `mcp__supabase-production__get_advisors` / `get_logs` / `list_migrations` all
worked correctly against the staging project_id — confirmed by the `identifier` field on returned
log rows matching `cifwmndunmlxjhyjugxa`. This matches AGENTS.md §8: "the project_id argument is the
only thing separating staging from production on every call."

**How to apply:** if `mcp__supabase-staging__*` returns empty/permission-denied, don't conclude the
staging database itself is down — cross-check with `mcp__supabase-production__*` passing the staging
project_id before concluding anything about the database. Only the staging-named server's own auth
looked broken; the staging database was healthy. Root cause was not diagnosed **on that date**
(reading the token env vars to compare was blocked by the auto-mode classifier as a secret-adjacent
read); it was diagnosed on 2026-09-12 and is written at the top of this file. ~~If this persists
across sessions, it likely needs the same kind of token refresh described in
[[supabase-mcp-and-cli-revoked-2026-08-02]].~~ — it was not a refresh: it was the **wrong account**.
