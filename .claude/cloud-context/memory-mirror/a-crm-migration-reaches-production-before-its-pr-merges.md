---
name: a-crm-migration-reaches-production-before-its-pr-merges
description: "A Phoenix CRM migration can be live on production and staging while its PR is still OPEN and RED — read the live function, never the migration file or main, before judging what production holds"
metadata:
  type: project
---

**Confirmed 2026-10-23, both projects (production `ozucdzovmcqvepbozvqf`, staging
`cifwmndunmlxjhyjugxa`).** While #6396 (*the Super Admin deletes a plan, a visit or a day record*)
was still red and #6401 (*…also a month's plan and a manager's own visit*) was **open and red**,
`public.phoenix_crm_admin_delete` was already live on **both** databases carrying **#6401's wider
version**: `md5(prosrc)` `40ad26edf53e3f341aa845afdc093e64`, 11,638 bytes, kind check already
allowing `monthly_plan` and `manager_visit`. Neither migration was on `main` at that moment.

The sessions apply through `node scripts/apply-sql-file.mjs <file> <project>` (the standing route
when `mcp__supabase-*__apply_migration` answers `{"status":"declined"}` — the server's guardrail on
a function body containing a `delete`) and record it in `ACKNOWLEDGED_EXCEPTIONS` in
`scripts/lib/migration-inventory.ts`. So the apply **is** documented — in a file you only read if
you go looking.

**How to judge what production holds:** query `md5(prosrc)`, `prosecdef`, the routine grants and
`pg_get_constraintdef` for the live object. A merged migration file, or its absence from `main`,
tells you nothing either way — this is the inverse of
[[merged-migration-file-does-not-mean-grants-are-live]] and of
[[migration-file-written-is-not-migration-applied]], and the reason
[[list-migrations-reports-ledger-not-reality]] matters: `apply-sql-file.mjs` writes **no ledger row**.

**His decision, asked as an MCQ and answered 2026-10-23: leave it as it is** — nothing was deleted
(the copy table read 0 rows on both), the function is service-role only, and no shipped code
reached the two extra kinds. #6401 merged at 22:48:05 Cairo the same night, so `main` and the
databases agree again on their own. Do not offer to drop or re-narrow a production function on this
pattern unless something is actually reachable or actually deleted.
