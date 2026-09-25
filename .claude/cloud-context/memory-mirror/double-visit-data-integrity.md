---
name: double-visit-data-integrity
description: "Double Visit Analytics data-correctness pitfalls + fixes — 1000-row PostgREST cap, current-month default, Vacant HR-id recovery, import atomicity; and the executive-report build."
metadata: 
  node_type: memory
  type: project
  originSessionId: bad8112a-e551-4d0d-b6dc-a1c259921b36
---

Double Visit Analytics (`/admin/double-visit-analytics`, service `src/lib/double-visit-analytics/`) had repeated "wrong/zero data" incidents on 2026-06-16. Root causes + fixes shipped on branch `codex/dv-executive-report` (PR #229):

- **PostgREST 1000-row cap (the big one):** `getPublishedRows` used `.limit(20000)` but the project enforces `db-max-rows ~1000`, silently truncating any snapshot >1000 rows. The published `DSM DV.xlsx` = 1297 rows / 5018 visits but the dashboard summed only the first ~1000 (~3800). Fixed by paging with `.range(from, from+pageSize-1)` until a short page. **`getEmployeeDirectoryRows` (employee-directory.ts) is STILL unpaginated `supabaseRest` — latent; 157 employees today so safe until ~1000.**
- **Current-month default:** dashboard defaulted to `currentMonthBounds()` (June only = 656) under a header labelled with the import's full range. Now defaults to the published import's full span via `getLatestPublishedImport()`. Only one import is `published` at a time (publish supersedes others). `asOfDate` for MR scores = `dateTo` (snapshot end), so recency metrics are relative to the snapshot, not today.
- **"Vacant" HR-id drops real reps:** the source sheet logs active reps' seats as `Vacant`/blank/`#N/A` in the HR ID column while the name stays in the "Employee" cell, dumping their received DVs into the unmapped bucket. The sheet's "Employee" cell EXACTLY equals `employees.crm_username` → recover via `recoverVisitedEmployeesByCrmUsername` (exact + unique active match only). Backfilled prod once: 1705 visits → 29 reps (e.g. Fiby Wagdy Luka B-52: 0→40). Two HR-id domains: `canonicalHrIdKey` (all joins/keys) vs `normalizeHrIdForAccess`/`normalizedHrKey` (descendantHrIds team denominator) — only ever COUNT across domains, never intersect the sets.
- **Import atomicity:** chunked row inserts are non-transactional → added a post-insert row-count assertion that rolls the import back on mismatch; zero-visit imports and missing-required-column / wrong-sheet files now abort loudly instead of publishing empty/partial.

Deep multi-agent audit (2026-06-16) confirmed data fidelity (stored rows == parsed == raw Count sum, no dups/anomalies) and found NO further truncation / HR-id cross-domain / compute gaps. Residual flagged items (not fixed): `getEmployeeDirectoryRows` pagination (latent) and a non-admin access-scope edge (RM/PM whose directory row or region/line is missing collapse to descendants-only → under-show). See [[command-center-perf-on2-sales]] for the related "verify totals against source, not just that it renders" lesson.
