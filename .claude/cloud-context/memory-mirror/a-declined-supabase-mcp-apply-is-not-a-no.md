---
name: a-declined-supabase-mcp-apply-is-not-a-no
description: "The Supabase MCP apply_migration can come back {status: declined} three times running even with the owner's typed authorization, and that decline is the TOOL LAYER, not his answer - so do not read it as a standing block and do not hammer the tool. SUPERSEDED 2026-10-15 - `scripts/apply-sql-file.mjs` IS NOW THE STANDING ROUTE, with no per-migration word ("make apply-sql-file.mjs the standing route when the MCP refuses a migration"), which reverses this note's own 2026-10-08 correction; the rule and its mechanics live in `.claude/rules/database.md`, "The migration ledger". It works, and it does NOT write the ledger, so put the ledger insert INSIDE the SQL file (one `sql.unsafe` runs the whole file, which is how `withLedgerInsert` keeps the staging path atomic) with the FILE's own version, because that is what the staging workflow records."
metadata:
  node_type: memory
  type: project
  originSessionId: 35b44469-be05-434e-98f8-ff8164de6273
---

Measured 2026-10-07/08 while hardening `phoenix_crm_customers_no_late_reference`'s `search_path`.
`mcp__supabase-staging__apply_migration` and `mcp__supabase-production__apply_migration` returned
`{"status":"declined"}` **three times** — once on staging, twice on production, the third time
immediately after the owner typed `apply the search_path hardening to production`. So the decline
was the tool layer, not his answer, and §6's "a classifier denial is stale authorization, the fix is
a fresh word from him" did **not** clear it.

**Do not read that as a standing block, and do not hammer the MCP tool.** The way past it is the
fallback route below.

🔴 **SUPERSEDED 2026-10-15 — THE FALLBACK IS THE STANDING ROUTE NOW, AND NEEDS NO PER-MIGRATION
WORD.** The owner's own words, after two sessions had escalated the same question on one day:
*"make apply-sql-file.mjs the standing route when the MCP refuses a migration"*. The live rule, with
the pooler host, the no-ledger-row consequence and the evidenced `ACKNOWLEDGED_EXCEPTIONS` entry it
must end in, is `.claude/rules/database.md`, "The migration ledger". Everything from here to the end
of this note stays because the MECHANICS are still exactly right; only the authorization sentence in
the 2026-10-08 correction below is dead. What refuses, measured twice on 2026-10-15: both
pre-authorized doors decline a `create or replace function` whose BODY merely CONTAINS a `delete` or
a `drop table if exists pg_temp.…` — the classifier reads it as the statement being run — so #5923
merged with its fix live only in code while production kept the old body.

🔴 **The 2026-10-08 correction, now historical — IT NO LONGER BINDS.**
AGENTS.md §8 pre-authorizes the `supabase-staging` and `supabase-production` MCP servers and the
`supabase` CLI (incl. `db push`), and §6's protected action 2 excepts exactly those two.
`scripts/apply-sql-file.mjs` is neither: it opens a DIRECT Postgres connection over the pooler with
`PHOENIX_PRODUCTION_DATABASE_URL`, and AGENTS.md does not name it anywhere (its only appearance is
the `apply-sql-file-default-pooler-host-is-wrong-for-production` slug in §2.1's roster). So **a
PRODUCTION run through it is a protected action and needs the owner's explicit word for that
migration** - which the measured run HAD (he typed `apply the search_path hardening to production`),
and which is the only reason it was correct that day. Staging is pre-approved either way (§6).
Caught by the review bot on #5479, where this note was about to be filed into
`.claude/rules/database.md` as a standing instruction.

With that approval in hand, the repo ships the explicit apply step:

```
PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com node scripts/apply-sql-file.mjs <file.sql> production
```

It worked first try. The env-var prefix is mandatory for production — see
[[apply-sql-file-default-pooler-host-is-wrong-for-production]], which is the note that saved the run
after the bare command failed with `(ENOTFOUND) tenant/user postgres.<ref> not found`.

🔴 **AND DO NOT APPLY IT AS TWO CALLS — PUT THE LEDGER INSERT INSIDE THE SQL FILE.**
`apply-sql-file.mjs` runs the whole file through ONE `sql.unsafe(text)` (line 89), so an insert
appended to the file lands in the same statement batch as the DDL. That is exactly what the staging
path does: `withLedgerInsert(sqlText, migration)` in `scripts/apply-migrations-to-staging.ts:163`
appends the very same statement to the SQL text and runs it with one `sql.unsafe(...).simple()`.
A separate second call leaves a window — an interruption, a declined follow-up, a tired operator —
where the schema has changed and the version still reads pending, and a later `db push` re-runs a
migration that is not idempotent. Raised by the review bot on #5479 and taken.

🔴 **`apply-sql-file.mjs` DELIBERATELY DOES NOT TOUCH `supabase_migrations.schema_migrations`** — it
prints `{"applied":true}` and the ledger still shows the migration as pending, so a later
`supabase db push` would re-run it. Record it yourself, **with the FILE's own version, not a fresh
UTC stamp**:

```sql
insert into supabase_migrations.schema_migrations (version, name)
values ('<the filename's 14 digits>', '<the filename's slug>')
on conflict (version) do nothing;
```

**Why the file's version and not a new one:** `staging-migrate.yml` runs `db push` on the merge and
records **exactly** the filename's version, so using the same string is what makes the two
environments' ledgers agree. Stamping a fresh UTC version — which `apply_migration` does — is the
`a-ledger-version-never-matches-the-file` trap, and here it would have put two different versions on
the two environments for one file.

**Prove a trigger still fires after pinning `search_path` with a self-aborting DO block**, which is
safe on production because it can never persist:

```sql
do $probe$ declare v_id uuid; v_outcome text; begin
  select id into v_id from <table> where <precondition> limit 1;
  begin <the update>; v_outcome := 'NO REFUSAL -- guard did not fire';
  exception when others then v_outcome := sqlstate || ' / ' || sqlerrm; end;
  raise exception 'PROBE RESULT: %', v_outcome;   -- unconditional: aborts the block either way
end $probe$;
```

The result comes back as the error text, and the final `raise` guarantees the update is rolled back
**even when the guard failed to stop it** — which is the case a plain `begin; … rollback;` loses if
the statement aborts the transaction first.
