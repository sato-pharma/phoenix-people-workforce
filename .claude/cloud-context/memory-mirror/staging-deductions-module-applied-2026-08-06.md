---
name: staging-deductions-module-applied-2026-08-06
description: "Staging finally got the Deductions module (2026-08-06) — and doing it exposed that marketing_request_report_share_links' RLS lives only in production, not in any migration"
metadata: 
  node_type: memory
  type: project
  originSessionId: bbfccdf5-5bbf-4ee5-94df-254a1b202152
  modified: 2026-08-05T21:14:38.152Z
---

**Staging (`cifwmndunmlxjhyjugxa`) now HAS the Deductions module.** Applied
2026-08-06, closing a gap open since 2026-08-01. Supersedes the "staging has no
deductions module" note in
[[list-migrations-reports-ledger-not-reality]].

Seven migrations applied in timestamp order: `20260725115137_deductions_module`,
`20260725130500_..._publish`, `20260725141943_..._comments`,
`20260725161204_..._safety_constraints`,
`20260801140000_..._pin_trigger_search_path`,
`20260802094500_deductions_decisions_applied_dates`,
`20260805120000_marketing_request_report_share_links`.

Staging and production now agree exactly: 8 tables, 107 columns, 4 functions
(identical body hashes), 26 indexes, 15 policies, 3 triggers, 52 constraints, 8
RLS-enabled tables, 7 seeded categories, 3 search_path-pinned trigger functions,
and `phx_publish_deductions` locked away from anon/authenticated.

**The trap this exposed — a FOURTH prod-only drift.**
`20260805120000_marketing_request_report_share_links.sql` creates the table, an
index and comments, and **nothing else**. Production additionally has RLS
enabled, a `..._service_role_all` policy, and anon/authenticated revoked — all
applied by hand, recorded in no migration. Rebuilding from
`supabase/migrations/` therefore produces a **share-link table with RLS off**,
holding bearer tokens and passcode hashes. I applied the hardening to staging to
reach parity; **the repo still does not contain it.**

Same family as [[phx-customer-directory-lives-only-in-prod]]: production hardened
or fixed in place, repo never updated, and no existence check can see it because
the object exists — only its RLS/grants/body differ.

**How to apply:** when a migration creates a table in `public` that holds
credentials or PII, do not assume the migration secured it — compare
`relrowsecurity`, `relacl` and `pg_policies` against production before believing
the file is complete. A table can exist in both places and still be safe in one
and open in the other.
