---
name: a-write-revoke-does-not-stop-a-cascade-or-a-secdef-function
description: "Revoking service_role's INSERT/UPDATE/DELETE does NOT make a table read-only — an ON DELETE CASCADE and a SECURITY DEFINER function both run as the table OWNER and ignore it; both were live back doors around the sales_records freeze, closed on prod 2026-08-14"
metadata: 
  node_type: memory
  type: project
  originSessionId: b999e9ef-030a-4843-87cb-dfb024f13c09
  modified: 2026-08-14T16:21:44.118Z
---

The Rule #1 work froze `public.sales_records` (11,267 H1 rows, the only record of what H1 2026 was
actually paid on) by revoking `service_role`'s INSERT/UPDATE/DELETE. **That revoke protected almost
nothing.** Two separate paths wrote the table anyway, because both execute with the *table owner's*
rights rather than the caller's:

1. **`ON DELETE CASCADE`.** A referential action runs as the owner. `sales_records_batch_id_fkey`
   cascaded from `sales_import_batches`, so `POST /api/sales/imports/{id}/delete` destroyed frozen
   rows through the front door. Three batches held all 11,267 rows; production has **no PITR**.
2. **`SECURITY DEFINER`.** `phx_reassign_replacement_ownership` (owned by `postgres`) updated
   `manager_hr_id` on every row at/after `p_effective_date` — sourced from
   `employee_resignations.effective_date` for the person being replaced, which is routinely in the
   past (prod held 20 resignations dated inside H1). 880 rows / 6,436,342.01 EGP were reachable.

**Measured on staging, not assumed.** As `service_role`, two no-op writes against one row:

| Statement | Result |
| --- | --- |
| `update public.sales_records …` directly | `BLOCKED: permission denied for table sales_records` |
| the identical update via a `SECURITY DEFINER` fn | `SUCCEEDED, rows=1` |
| `delete from public.sales_records where batch_id=…` | `ERROR 42501 permission denied` |
| `delete from public.sales_import_batches where id=…` | succeeded — **the child row went with it** |

**Why:** a revoke is a *caller* privilege check. Cascades and definer functions are not the caller.
Reading "service_role has no UPDATE" as "this table cannot change" is the whole mistake, and it is
invisible in every grant listing — `has_table_privilege` reports the revoke faithfully and tells you
nothing about either bypass.

**How to apply.** Two sweeps find the whole class; run both before trusting any freeze:

```sql
-- FK side: a writing referential action pointing INTO a table whose grants are narrower than its parent's
select src.relname, tgt.relname, con.conname, con.confdeltype
from pg_constraint con
join pg_class src on src.oid=con.conrelid join pg_class tgt on tgt.oid=con.confrelid
where con.contype='f' and con.confdeltype in ('c','n','d')
  and has_table_privilege('service_role', tgt.oid, 'DELETE')
  and not has_table_privilege('service_role', src.oid, 'DELETE');

-- SECURITY DEFINER side: definer functions whose body writes the protected table
select pr.proname from pg_proc pr where pr.prosecdef
  and pr.prosrc ~* '(insert\s+into|update|delete\s+from)\s+(public\.)?<table>\M';
```

Fix in **two layers** — the app refuses with a usable message, the database refuses regardless:
`ON DELETE RESTRICT` (not `NO ACTION`, so the failure surfaces at the statement), plus removing the
write from the definer function. App-layer-only is bypassable; DB-layer-only gives a raw constraint
violation nobody can act on.

**APPLIED TO PRODUCTION 2026-08-14 — do NOT redo or undo:**

- `sales_records_batch_id_fkey` is now **`ON DELETE RESTRICT`**, `validated=true` (PR #2136), plus
  `assertSalesBatchHoldsNoFrozenRecords` in `src/lib/sales/service.ts` refusing with a 409 the route
  surfaces. Rejecting or replacing a batch still works; only deleting one is blocked.
- `phx_reassign_replacement_ownership` **no longer writes `sales_records`** (PR #2137, `500742e8`).
  Source md5 `e4015ecc…` → `638edfba…`, but the whitespace/comment-normalized body *minus that block*
  is unchanged at `b2b1d713…` — everything else is byte-identical. It reports
  `sales_records_reassigned: null`, matching how `sales_targets_reassigned` already reported.

After both, the FK sweep returns **zero rows** database-wide. Three tables carry a write revoke
(`sales_records`, `au.direct_region_allocation`, `marketing_request_events`); the only definer
functions still writing one are the two marketing capture functions, which merely INSERT into an
append-only table they are allowed to insert into.

Related: [[revoke-from-public-strips-service-role-on-default-acl]] (the EXECUTE half of this, and the
reason PR #2137's migration also states an explicit grant), [[production-supabase-has-no-pitr-only-daily-backups]]
(why one bad delete here is unrecoverable), [[rls-policy-without-an-authenticated-grant-is-usually-correct]],
[[list-migrations-reports-ledger-not-reality]] (verify with `pg_constraint`/`pg_proc`, never the ledger).
