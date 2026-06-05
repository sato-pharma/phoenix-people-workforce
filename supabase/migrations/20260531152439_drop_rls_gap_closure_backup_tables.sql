-- Performance advisor 0004 (No Primary Key): drop write-once RLS-hardening backup snapshots
-- from 2026-05-11 (private schema). Nothing reads these back; the source script only creates
-- fresh dated copies. Idempotent.
drop table if exists private.rls_gap_closure_backup_constraints_20260511180815;
drop table if exists private.rls_gap_closure_backup_constraints_20260511180835;
drop table if exists private.rls_gap_closure_backup_constraints_20260511181049;
drop table if exists private.rls_gap_closure_backup_constraints_20260511181154;
drop table if exists private.rls_gap_closure_backup_grants_20260511180815;
drop table if exists private.rls_gap_closure_backup_grants_20260511180835;
drop table if exists private.rls_gap_closure_backup_grants_20260511181049;
drop table if exists private.rls_gap_closure_backup_grants_20260511181154;
drop table if exists private.rls_gap_closure_backup_policies_20260511180815;
drop table if exists private.rls_gap_closure_backup_policies_20260511180835;
drop table if exists private.rls_gap_closure_backup_policies_20260511181049;
drop table if exists private.rls_gap_closure_backup_policies_20260511181154;;
