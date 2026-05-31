# Database

## Overview

Phoenix Workforce uses Supabase (hosted PostgreSQL) as its primary database. All data access goes through the Supabase client library (@supabase/supabase-js).

## Client Configuration

Two Supabase clients are available (defined in src/lib/supabase/server.ts):

| Client | Key | RLS | Use Case |
|---|---|---|---|
| getSupabaseUserClient() | Anon key | Respects RLS | User-scoped reads, default for most operations |
| getSupabaseAdmin() | Service role key | Bypasses RLS | Tightly bounded server tasks, admin operations |

Always prefer the RLS-respecting client for user-scoped data. The admin client should only be used for system-level operations where RLS would incorrectly restrict access.

## Schema

The database schema is defined and evolved through timestamped SQL migrations in supabase/migrations/. Key tables include:

- employees — core employee records (HR_ID is the primary business key)
- app_auth_users — application authentication (not Supabase Auth)
- salary_records, payroll_batches — payroll domain
- vacation_requests, leave_balances — leave management
- outstation_requests, medical_rep_expenses — field operations
- coaching_reports, coaching_scores — performance management
- offers, employee_contracts, employee_probation — hiring/lifecycle
- notification_outbox — notification delivery
- workflow_registry — approval flow definitions
- attendance_raw_punches, attendance_device_user_mapping — attendance

## Row-Level Security (RLS)

All tables have RLS policies. The security model combines:
1. Application-level permission checks (assertPermission in API routes)
2. Database-level RLS policies (enforce row visibility based on role/scope)

The dual-layer approach means even if application code has a bug, RLS prevents unauthorized data access at the database level.

## Validation Scripts

The repository includes database validation scripts under tests/scripts/ and npm db:* commands. These verify RLS policies, role alignment, and schema consistency. See docs/scripts.md for the full inventory with safety classifications.
