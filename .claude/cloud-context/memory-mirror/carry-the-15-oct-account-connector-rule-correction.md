---
name: carry-the-15-oct-account-connector-rule-correction
description: "🔴 THE NEXT DATABASE PR CARRIES ONE RULE EDIT — `.claude/rules/database.md`'s \"supabase-production DECLINES DESTRUCTIVE SQL\" bullet still says the account connector RUNS the same statement; on 2026-10-15 it answered -32600, so both MCP doors were shut. Take the line from commit 61324ccd5, minus its \"his word to give\" clause"
metadata:
  node_type: memory
  type: project
  originSessionId: cc6af00c-47dd-405e-9408-8224e7fe4553
  modified: 2026-10-23T00:31:24.801Z
---

Owner, 2026-10-23 ~03:35 Cairo: "carry the 15 Oct database rule correction in the next database PR".

**The edit:** in `.claude/rules/database.md`, rewrite the bullet that begins
`supabase-production DECLINES DESTRUCTIVE SQL ON PRODUCTION`. On main it still says the account
connector `mcp__b345e47e-…` "RUNS THE SAME STATEMENT". Take the corrected line from commit
`61324ccd5` (branch `claude/suggestions-text-box-missing-52c190` on origin, plus the local ref
`refs/deleted-claude-suggestions-text-box-missing-2026-10-23`): `git show 61324ccd5 -- .claude/rules/database.md`.

**What it corrects:** measured 2026-10-15 on a `create or replace function` whose body contains
`delete` and whose grants carry a `revoke`. `supabase-production` declined it, and the connector
refused it with `-32600 You do not have permission to perform this action`. Both MCP doors were shut.
`scripts/apply-sql-file.mjs` with `PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com` is
what applied it, and that leaves no ledger row.

🔴 **Drop one clause when carrying it:** the commit says a third channel "is his word to give, not
a door to try". The owner reversed that the same day: AGENTS.md §8 makes `apply-sql-file.mjs` the
STANDING route for a migration the MCP refuses, with no per-migration word. Point at the existing
"apply-sql-file.mjs IS THE STANDING ROUTE" bullet instead of contradicting it.

**Why:** the owner's order. It never reaches him as a PR by itself, because a one-line rules change
is a small PR he will not merge.
**How to apply:** the first PR that touches the `database` module (migrations, RLS, grants,
`supabase/`) edits that bullet in the same branch, keeps it under 1,200 bytes or citing its `docs/`
account, then removes this note's Inbox line once merged. Never open a PR for this line alone.
