---
name: supabase-staging-mcp-server-sees-zero-projects
description: "RESOLVED 2026-09-12 by PR #3726 — supabase-staging's empty project list and blanket -32600 refusals were a WRONG-ACCOUNT token, not a revoked one; it now runs on SUPABASE_PROD_TOKEN pinned with ?project_ref=cifwmndunmlxjhyjugxa, takes no project_id at all, and is called directly. Do NOT reach staging through supabase-production any more"
metadata: 
  node_type: memory
  type: project
  originSessionId: bc64a6e6-925a-4aa2-970d-6dfa931aa34f
  modified: 2026-09-11T22:04:29.668Z
---

🔴 **RESOLVED 2026-09-12 — PR #3726, merged as `d9697de8a`. The 2026-08-27 observation below is
accurate history; its CONCLUSION was wrong.**

The line below reading *"the staging server's own access token can no longer see any project"* was
half right and pointed the wrong way — it reads as a revocation to chase, and cost a month of routing
staging through the production server. `SUPABASE_STAGING_TOKEN` (fp `883d5882`) was never revoked: it
belongs to a **different Supabase account**, whose one organization holds **0 projects**. An empty
`list_projects` is the correct answer for that token, which is why nothing about it ever looked
broken from the server's side. **That old token is still live in the other account — revoke it there.**

`supabase-staging` now uses `${SUPABASE_PROD_TOKEN}` with `?project_ref=cifwmndunmlxjhyjugxa`.
**Call it directly and pass NO `project_id`** — the scoped server removes `list_projects` and
`create_project` entirely, and refuses a passed production `project_id` with `unrecognized_keys`, so
it has no path to production at all. The "resolve the ref with `list_projects` first" ritual below no
longer applies to this server (the tool is gone); it still applies to `supabase-production`.
⚠ `${VAR}` in `.mcp.json` expands at **app start**, so the pinned server appears only after a full
quit-and-reopen of the Claude desktop app. First sighting of the same fault:
[[supabase-staging-named-server-broken-2026-08-10]].

---

Verified live 2026-08-27. `mcp__supabase-staging__list_projects` returns `{"projects":[]}`, and **every**
other call on that server — `execute_sql` and `apply_migration` alike, reads included — fails with:

```
MCP error -32600: You do not have permission to perform this action
```

It is not the deny list (that holds only `mcp__b345e47e-…` and `mcp__45bb6356-…`), and it is not the
account: `mcp__supabase-production__list_projects` returns all four projects the same minute, and its
`execute_sql` and `apply_migration` both work against **any** of them.

**Why:** the staging server's own access token can no longer see any project. Nothing in the repo or
in `AGENTS.md` says so — §3 still claims *both* named servers see all four, which is now half wrong.

**How to apply:** to touch staging, call `mcp__supabase-production__*` with
`project_id: "cifwmndunmlxjhyjugxa"`. That is not a workaround so much as the rule §8 already
states — *the server name guarantees nothing; the `project_id` argument is the only thing separating
staging from production on every call* — except that it is now load-bearing rather than a caution.
Resolve the ref with `list_projects` first, every time, and read the result back from the ref you
meant AND the one you did not: on 2026-08-27 a staging migration was confirmed by querying
`pg_attribute` on both refs, staging returning the new column and production still returning 0.

~~Do not spend time debugging the staging server~~ — that instruction is what kept the real cause
hidden for a month; it was one `GET /v1/organizations` away. Do not read a refusal as a sign the work
was wrong. Related: [[migration-file-written-is-not-migration-applied]].
