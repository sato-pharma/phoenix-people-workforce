---
name: append-only-tables-need-a-truncate-trigger
description: "An append-only table in this repo needs a STATEMENT-level BEFORE TRUNCATE trigger — row triggers and revoking from service_role both miss TRUNCATE."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 4d615aae-6dc5-4362-b4f4-d602d9620a11
  modified: 2026-08-13T02:02:16.015Z
---

Proven on staging 2026-08-13 while building `marketing_request_events`. With a `BEFORE UPDATE OR
DELETE ... FOR EACH ROW` guard correctly refusing both, this still **succeeded and emptied the
table**:

```sql
truncate table public.marketing_request_events;
```

Two independent reasons, and fixing one does not fix the other:

1. **TRUNCATE fires no ROW triggers.** The append-only guard never ran.
2. **Revoking TRUNCATE from `service_role` does nothing to the table OWNER**, whose privileges
   cannot be revoked — and migrations run as the owner.

The fix that actually works, because a statement-level trigger *does* fire for the owner:

```sql
create trigger <t>_no_truncate
  before truncate on public.<table>
  for each statement execute function public.<guard_fn>();
```

**Also non-obvious:** Supabase's default ACL grants `service_role` **ALL** on every new table in
`public`. A bare `grant select, insert on <table> to service_role` therefore restricts nothing —
the table comes up already holding DELETE/UPDATE/TRUNCATE. They must be revoked explicitly:

```sql
revoke update, delete, truncate on table public.<table> from service_role;
```

Revoke from the *named* roles, never from `PUBLIC` — see
[[revoke-from-public-strips-service-role-on-default-acl]].

**How to apply:** whenever a table is described as append-only, immutable, or an audit log, verify
all three of UPDATE, DELETE and TRUNCATE are actually refused before believing the claim — and test
it against a real database, not by reading the SQL. Neither of these two defects was visible from
source review, and neither would have failed a test written in advance.

A superuser can still `ALTER TABLE ... DISABLE TRIGGER`; nothing in the database stops that. What
this removes is the accidental and casual wipe.

Related: [[marketing-request-events-is-the-history-table]] ·
[[list-migrations-reports-ledger-not-reality]]
