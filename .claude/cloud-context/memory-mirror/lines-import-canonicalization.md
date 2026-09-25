---
name: lines-import-canonicalization
description: "Employee-org import re-created the duplicate \"Anti Inf\" lines row; fixed at lineRules (PR #1118)"
metadata: 
  node_type: memory
  type: project
  originSessionId: f2052a5b-d2b4-46ea-9c8a-82be1c8eb6a0
---

The duplicate **"Anti Inf"** `lines` row (deleted id 53, split the Anti-Infective line across Employee 360 + other reports) was **re-created by the employee-org import** on every run — data merges alone couldn't stop it.

**Mechanism:** `app/api/imports/employees/confirm/route.ts` → `upsertLines` upserts `lines` with `onConflict:"code"`, where `code = createOrgCode(mapped line name)`; the employee→line link uses the same code (`employee-validator.ts` `lineCode`). `src/lib/imports/org-rules.ts` `lineRules` still mapped anti-infective variants to **"Anti Inf"** (slug `anti_inf`) after migration `20260621240000` renamed line id 1 to **"Anti infective"** (`anti_infective`). `anti_inf ≠ anti_infective` → a fresh divergent-code row instead of updating id 1. `office → "Office"` was the same trap vs stored `head_office` (id 4).

**Canonical `lines` rows (single source of truth, verified in prod):** `anti_infective`/"Anti Infective" (1), `pedia`/"Pedia" (2), `cns`/"CNS" (3), `head_office`/"Head Office" (4). NOTE: line 1's display name was re-standardized "Anti infective" → **"Anti Infective"** on 2026-07-18 (owner decision); code `lineRules` value + prod `lines.name` both updated. `code` stays `anti_infective`. See [[anti-infective-canonicalization]].

**Fix (PR #1118, branch `codex/import-line-canonicalization`):** `lineRules` values now equal the exact `lines.name`, so the derived code matches the canonical row and the upsert updates it. Regression test `tests/imports-line-canonicalization.test.ts` locks variant→canonical mapping AND an invariant that every `lineRules` value slugs to a real `lines.code` — reintroducing an off-canonical label fails CI.

**How to apply:** `lineRules` values MUST stay byte-identical to `lines.name`; verify against the DB before adding a line. The sales-linkage matcher (`admin/access-control.ts` alias map) still handles "Anti Inf" as an INPUT alias — independent of the import. Related: the earlier display-side canonicalization `bridgeEmployeeLineToOfficial` in `src/lib/sales/access-scope.ts`.
