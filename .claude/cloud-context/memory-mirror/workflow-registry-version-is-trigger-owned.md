---
name: workflow-registry-version-is-trigger-owned
description: "A BEFORE UPDATE trigger owns workflow_registry_modules.version — setting it in a migration is silently ignored, and splitting one change across N UPDATEs bumps it N times."
metadata: 
  node_type: memory
  type: project
  originSessionId: abc0ae14-8b9d-4da5-8d28-5371ddddceed
  modified: 2026-08-04T08:20:48.314Z
---

`public.workflow_registry_modules` carries a `BEFORE UPDATE` trigger,
`workflow_registry_modules_touch` → `phx_touch_workflow_registry_module()`, which does:

```sql
new.updated_at = now();
if tg_op = 'UPDATE' then new.version = coalesce(old.version, 1) + 1; end if;
```

Two consequences that are invisible where you'd actually write the code:

1. **Assigning `version` (or `updated_at`) in an UPDATE does nothing.** The trigger overwrites
   whatever you set. A migration line like `version = version + 1` — or a "fix" making that bump
   conditional — reads as intent and has zero effect.
2. **Every UPDATE statement bumps the version once.** So a single logical change split across
   three `update workflow_registry_modules` statements moves the counter by 3, not 1.

Both were hit on 2026-08-04 while adding the outstation two-photo gate: the registry version went
4 → 7 from ONE migration apply, which read exactly like the migration had been applied three
times. It had not — `supabase_migrations.schema_migrations` had a single row for it. The wrong
inference cost real time; the trigger is the whole explanation.

**How to apply this:** when a migration changes a registry module, do it in **one** UPDATE
statement and do not mention `version` or `updated_at` at all. Guard each jsonb append with a
`NOT EXISTS` on the key so re-applying is a no-op (the version will still tick, unavoidably —
the trigger owns it, so the counter is "number of updates", never "number of schema versions").

The trigger is defined in `supabase/migrations/20260711135352_phoenix_production_schema_baseline.sql`
(and the pre-baseline archive), i.e. it IS in the repo — but buried in the baseline dump, so
nothing surfaces it when you are writing a new migration against that table.

Related: [[list-migrations-reports-ledger-not-reality]] — the ledger said one apply, and the
ledger was right; it was the version counter that was misleading.
