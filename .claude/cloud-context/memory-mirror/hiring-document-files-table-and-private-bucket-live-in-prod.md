---
name: hiring-document-files-table-and-private-bucket-live-in-prod
description: "public.hiring_document_files and the private hiring-documents storage bucket were applied to PRODUCTION on 2026-08-22, ahead of the PR that uses them"
metadata:
  type: project
---

Applied to **production** (`ozucdzovmcqvepbozvqf`) on **2026-08-22 ~20:20 Cairo**, with the owner's
explicit "apply it". Rehearsed on staging (`cifwmndunmlxjhyjugxa`) first; both are identical.

- `public.hiring_document_files` — the scan/photo/PDF behind each hiring-document tick. One row per
  file, keyed `employee_hr_id` × `document_id`. `document_id` is a real FK to
  `hiring_document_definitions` (`on delete cascade`); `employee_hr_id` is deliberately plain text,
  matching `hiring_document_statuses`.
- Private storage bucket `hiring-documents` — `public = false`, 15 MB cap, MIME allow-list
  `application/pdf, image/jpeg, image/png, image/webp`, plus a `service_role`-only policy
  `hiring_documents_service_role` on `storage.objects`.

Verified against `pg_class`/`pg_policies`/`storage.buckets`, not `list_migrations`: `relrowsecurity`
true, 3 indexes, 1 FK, **0 grants to anon or authenticated**, bucket private, storage policy present,
0 rows.

**Why:** the schema went in **BEFORE** the PR merged, on purpose. The dashboard's file-count query
fails soft on a missing table, so either order is safe — but applying first means the Scan & Upload
tab never appears in a state where saving returns "not ready yet".

**How to apply:** the one security advisory it raises, `rls_enabled_no_policy` (INFO), is CORRECT and
must not be "fixed" by adding a policy — **85 other tables here carry the identical notice**. RLS on
with no policy denies anon and authenticated outright, and reads go through the service-role client
behind `assertPermission(ctx, 'employee_documents', …)`. See
[[app-visibility-is-application-scoped-not-rls]] and
[[rls-policy-without-an-authenticated-grant-is-usually-correct]].

Write access is Super Admin and Talent Acquisition only — the same `employee_documents:update` that
already gated ticking a document done, not a new boundary.

Related: [[migration-file-written-is-not-migration-applied]],
[[migration-ledger-version-never-matches-the-filename]],
[[sharp-is-a-devdependency-that-two-production-paths-import]].
