# Database & Data-Model Hardening — 2026-06-15

Remediation for the database-layer audit findings. Every finding was **verified
against live production** (Supabase ref `ozucdzovmcqvepbozvqf`) before any SQL was
written — several audit claims were refined as a result (see notes).

Branch: `codex/db-data-model-hardening`. **No migration has been applied to any
database yet** — all applies are staging-first and approval-gated per AGENTS.md.

## Apply order (staging → production, after approval)

| # | Migration | Finding | Risk | Status |
|---|-----------|---------|------|--------|
| 1 | `20260615090000_audit_view_security_invoker.sql` | `v_unified_audit_logs` definer view, not in repo | Low | Ready |
| 2 | `20260615091000_drop_permissive_pii_rls_policies.sql` | Permissive `USING(true)` RLS on employees/salary_records/user_access_profiles ("Blocker #5") | Medium | Ready |
| 3 | `20260615092000_lockdown_terminate_employee_rpc_execute.sql` | `phx_terminate_employee_for_non_renewal` EXECUTE granted to `authenticated` in prod | Medium | Ready |
| 4 | `20260615093000_pin_function_search_path.sql` | 4 functions with mutable search_path | Low | Ready |
| 5 | `20260615094000_add_missing_fk_covering_indexes.sql` | 17 unindexed FKs | Low | Ready |
| 6 | `20260615095000_drop_duplicate_indexes.sql` | 3 duplicate indexes | Low | Ready |

Deferred (in `supabase/migrations/_deferred/`, NOT auto-applied):

| File | Why deferred |
|------|--------------|
| `20260615096000_drop_sos_geo_backup_table.sql` | **Destructive.** Drops the 33,311-row pre-backfill SoS geo snapshot. Apply only after the brick-geography backfill is verified + owner approval. |
| `20260615097000_drop_permissive_sales_rls_policies.sql` | Sales RLS overlaps active `codex/weekly-sales` work — coordinate before applying. |

## Per-finding detail

### Critical

1. **`v_unified_audit_logs` SECURITY DEFINER view, not source-controlled.** Captured
   the exact live definition (schema-qualified) into migration #1 and set
   `security_invoker = true`. App reads audit data via the service-role client, so
   no behavioural change; direct authenticated reads now honour RLS. *(Migration 1)*

2. **`sos_import_rows_geo_backup_20260615` leftover backup (33,311 rows, no PK).**
   Confirmed live. Drop is **deferred** — it is the rollback snapshot for the SoS
   brick backfill and is irreversible. *(Deferred migration; owner decision)*

### High

3. **Permissive PII/salary RLS ("Blocker #5").** Confirmed live: 8 `TO public
   USING(true)` policies across `employees`, `salary_records`,
   `user_access_profiles` OR-combine with — and nullify — the gated policies.
   Dropped; each table retains its full gated CRUD set + explicit `service_role`
   policy. No app blast radius (`service_role` has `rolbypassrls=true`;
   `authenticated` does not). *(Migration 2)*. **The sweep is wider than the three
   PII tables** — six `sales_*` policies are named `*_service_role` but are actually
   `TO public USING(true)`. That fix is staged in the deferred sales migration.

4. **`phx_terminate_employee_for_non_renewal` callable by `authenticated`.** The RPC
   is SECURITY DEFINER, terminates an employee + opens a vacancy, and has **no
   internal authz gate**. The source migration grants only `service_role`, but live
   prod grants `{service_role, authenticated, postgres}` (regained out-of-band).
   Re-asserted service-role-only EXECUTE. *(Migration 3)*

5. **`auth_leaked_password_protection` disabled.** This is a Supabase **Auth config**
   setting, not SQL — it cannot be fixed by a migration. **Manual step:** Supabase
   Dashboard → Authentication → Policies → enable "Leaked password protection"
   (HaveIBeenPwned). Owner/approval-gated.

### Migration-ledger drift (operational — audit claims refined)

- **"2 repo migrations applied out-of-band":** refined. `20260612172427_double_visit_analytics`
  and `20260612184939_weekly_pos_region_mappings` are absent from the prod ledger,
  **and their tables do not exist in prod** — they are simply *unapplied pending*
  migrations, not applied-out-of-band. Do **not** record them as applied. Decide:
  apply them, or confirm they were superseded (`weekly_sales_pos_region_mappings`
  exists) and retire the files.
- **"6 prod-recorded changes with no repo file":** the recent (2026-06-13/14) SoS /
  weekly-mapping migrations exist in prod but not on `main` because they live on the
  **unmerged `codex/weekly-sales` branch** (worktree `_wt-weekly-sales`), plus one
  idempotent double-apply (`20260610111629` = a second apply of `attendance_exceptions`).
  Resolution is to **merge the feature branch**, not to dump prod DDL into new files
  here (that would collide). No action on this branch.
- **"12 logical migrations re-applied under different versions":** idempotent and
  harmless (e.g. `company_calendar_events` ×3, `weekly_monthly_plans_v1` ×2). Leave
  as-is; flagged so future migrations stop being re-stamped.

### Medium / Low

- **3 duplicate indexes** dropped (keeping the constraint-backed / canonical one);
  the `source_of_sales_import_rows` pair is the high-value one (~52 MB on the
  hottest table). `v2_vacation_requests` left alone (DESC vs ASC, not a true dup).
  *(Migration 6)*
- **17 unindexed FKs** indexed. *(Migration 5)*
- **311 "unused index" advisors:** noise at current scale — **not** dropped.
- **4 mutable-search_path functions** pinned to `public, pg_temp`. *(Migration 4)*

### Confirmed healthy (no action)

`employees.hr_id` is the PRIMARY KEY; no bare `line` column; no NUL bytes in
migrations; the dead leave engine is fully dropped; RLS enabled on every table.
