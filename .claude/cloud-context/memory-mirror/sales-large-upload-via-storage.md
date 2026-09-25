---
name: sales-large-upload-via-storage
description: "Sales workbooks >4MB upload to a private Supabase Storage bucket via a signed URL (bypassing Vercel's ~4.5MB serverless body cap); /validate then reads from storage. Additive — small files keep the multipart path."
metadata: 
  node_type: memory
  type: project
  originSessionId: 4c6b1a35-ca2b-485e-9d54-4574469354a1
---

**Problem:** Vercel serverless functions cap the request body at **~4.5MB** (`FUNCTION_PAYLOAD_TOO_LARGE` at the edge, before the function runs). Large distributor monthly sheets — Overseas/PS are ~4.3–4.55MB once the Phoenix coded columns are appended — couldn't be uploaded through `/api/sales/monthly-import/validate` (multipart FormData POST). The route's own "10MB" check never even runs; Vercel rejects first.

**Fix (SHIPPED to prod 2026-06-11, commit `7955bf8`, deployed + verified live):** browser uploads files **>4MB straight to Storage**, bypassing the function body entirely.
- New **private bucket `sales-imports`** (migration `20260611053634_sales_imports_storage_bucket`, 20MB limit, service-role + signed-URL only, no public access / no RLS needed).
- New **`POST /api/sales/monthly-import/upload-url`** — permission-gated (`assertPermission(sales, import)`); `getSupabaseAdmin().storage.from('sales-imports').createSignedUploadUrl(path)` → returns `{ path, token, signedUrl }`. `signedUrl` is a **FULL url** → the browser PUTs the file directly to it with a plain `fetch` (`method:'PUT'`, `x-upsert:false`) — **no supabase-js in the browser bundle**.
- **`/validate`** gained a JSON `{ storagePath, distributorCode }` branch: downloads via service role → `new File([buffer])` → same `importSourceOfSalesFile` → deletes the temp object in `finally`. The **multipart small-file path is byte-for-byte unchanged** (additive — proven flow can't regress).
- **Client** (`sales-import-workspace.tsx` `handleValidate`): `selectedFile.size > 4*1024*1024` → storage path (upload-url → PUT → validate-by-reference); else the original FormData POST.

**Verified** the full round-trip with the real **4.55MB PS March** file via script (createSignedUploadUrl → uploadToSignedUrl/PUT → service-role download → `validateDistributorSalesWorkbookBuffer` = Overseas PS template, validated, **33,235 rows**). Post-deploy: prod 200, `upload-url` returns 403 w/o session (deployed + gated).

**Interim band-aid (still useful for one-offs):** slim a too-big file to only the columns the importer reads — I produced `PS March 2026 - upload.xlsx` (4.55→**1.77MB**, same 33,235 rows). The slim script keeps: customer/qty/date/discount/bonus + Product/Brick/Area/Region/Distrub ID + product name; drops the rest + the lookup sheet. Related: [[sofico-upload-template-recognition]], [[vercel-pro-and-deploy-recovery]].

**GOTCHA (2026-06-21, PR #415):** the storage fix above was only wired into **`/sales/import`** (`sales-import-workspace.tsx` → `/api/sales/monthly-import/{upload-url,preview,commit}`). The OTHER upload page **`/sales/upload`** (`sales-upload-workspace.tsx`, the 3-step verify→analyze→import wizard → `/api/sales/sales-upload/{analyze,commit}`) was NEVER migrated and still POSTed the whole workbook → user hit `FUNCTION_PAYLOAD_TOO_LARGE` again. Fix = same pattern: new shared `resolveUploadedSpreadsheet(request)` in `monthly-import-request.ts` (JSON-storagePath OR multipart; caller deletes temp via `removeSalesUploadObject`), analyze/commit use it, and a client `postSalesUpload()` helper switches to signed-URL >4MB. Lesson: when adding a NEW sales upload surface, route it through `resolveUploadedSpreadsheet` + `postSalesUpload` from the start. (`main`'s `/sales/upload` is monthly-only; weekly large-file path on `weekly-upload-workspace.tsx` is still un-migrated — separate latent bug, being fixed on `codex/weekly-sales-payload-cap`.) **STATUS: PR #415 MERGED to main + deployed to prod 2026-06-21 ~05:02 (squash `19123f57`), AFTER the full-day revert [[revert-2026-06-21-full-day]] — so `/sales/upload` IS fixed in prod despite most 2026-06-21 work being rolled back. Code-only, no migration.**
