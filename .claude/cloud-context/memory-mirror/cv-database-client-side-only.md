---
name: cv-database-client-side-only
description: "The \"CV Database\" is a client-side Excel tool, not a persisted DB — no table, no storage, no server records."
metadata: 
  node_type: memory
  type: project
  originSessionId: 76fc0d1e-2403-48fe-9b8c-a1fb8991cc9a
---

The CV Database (`/admin/cv-database`, [cv-database-manager.tsx](src/components/cv/cv-database-manager.tsx), [cv-database.ts](src/lib/cv/cv-database.ts)) parses an uploaded `.xlsx` in the browser, filters/renders in memory, and re-exports `.xlsx`. There is **no `cv`/`candidate`/`applicant` table, no Supabase Storage bucket, and no API persistence** — the only route is `GET /api/cv-database/template`, which serves a blank template.

The two `*_candidates` tables in `supabase/` (`payroll_resignation_candidates`, `deduction_candidates`) are payroll/deduction artifacts, unrelated to recruitment. All recruitment candidate PII actually lives in `job_offers`.

Consequences: no audit/retention/access-log of who viewed candidate PII; candidate counts have no dedup key (rows keyed by `rowNumber-name-cvName` in the UI). Don't assume a CV table exists when wiring recruitment features — adding persistence requires RLS + server-only grants from day one.
