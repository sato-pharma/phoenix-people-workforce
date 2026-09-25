---
name: a-missing-table-answers-pgrst205-not-42p01
description: "A guard written as code === \"42P01\" for a missing TABLE never fires through PostgREST — it answers PGRST205 from its schema cache — so the deploy-before-migration window 500s the whole page instead of degrading"
metadata: 
  node_type: memory
  type: project
  originSessionId: c0000768-ad01-4363-ae69-9fed4bdb1857
  modified: 2026-08-30T05:53:16.336Z
---

A Supabase/PostgREST read against a table that does not exist comes back as
**`PGRST205 "Could not find the table 'public.<name>' in the schema cache"`**, with **no Postgres
error code at all**. `42P01` — Postgres's own `undefined_table` — is what the guard gets written as,
because that is the code you get from a direct `psql` connection and it is the one that looks right
in review. Through PostgREST it **never arrives**, so the guard reads correct and catches nothing.

Measured 2026-08-30 building the manager CV folders (`ats_candidate_manager_folders`, PR #2762)
against a database without the table: `listManagerFolderFilings` threw, and a manager's **entire
My Candidates page** rendered the portal error boundary. The page has nothing to do with folders —
one optional read on a table that had not landed yet took the whole screen down.

**Why:** this is not a theoretical window. [[railway-deploy-applies-no-migrations]] — a merge to
`main` ships to production in minutes and applies nothing, so between the deploy and the migration
being run by hand, every page that reads a new table is running against a database that has not got
it. That window is the normal case here, not the exception. A guard that only fires on `42P01` makes
the code *look* like it survives the window while guaranteeing it does not.

**How to apply:** treat "that table is not there" as a **set**, never one code —
`new Set(["42P01", "PGRST205"])` behind one `isMissingTable(error)` helper, so a read path and a
delete path cannot drift apart on it. Pin it in a registered test: reaching the real failure needs a
database that is missing a table, which no unit test can arrange, so source-pin the constant *and*
assert no bare `code === "42P01"` comparison comes back —
`tests/manager-folder-shelf.test.ts` is the worked example. Degrade to the empty answer, never to a
throw: an empty shelf is survivable, a dead screen is not.

Sibling, and a sharper trap because it degrades *silently* instead of 500ing:
[[pgrst202-missing-function-reads-as-missing-schema]] — a missing RPC is `PGRST202`, and matching it
by the words *schema cache* makes a missing function indistinguishable from a missing table.
