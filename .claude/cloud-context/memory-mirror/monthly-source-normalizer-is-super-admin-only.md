---
name: monthly-source-normalizer-is-super-admin-only
description: "The monthly Source Normalizer (/api/sales/normalizer/**) is Super-Admin-ONLY via a hard role check before assertPermission; 5 of its 13 routes have no access-registry entry, and 2 write with no input bail."
metadata: 
  node_type: memory
  type: project
  originSessionId: 26968de2-24de-4b16-a339-4065a48eba87
  modified: 2026-08-20T23:05:56.270Z
---

The **monthly** Source Normalizer lives at `/api/sales/normalizer/**` — the **unprefixed** path.
`/api/sales/weekly/normalizer/**` is the weekly one. Same folder names, different modules; don't
mix them up when reading a route path.

## It is Super Admin only, and not by the permission matrix

All 13 routes open with the same two lines, **before** `assertPermission`:

```ts
if (access.role !== "Super Admin" && access.scope !== "system") return 403
await assertPermission(access, "sales", "import" | "export")
```

`scopeForRole()` (`src/lib/auth/permissions.ts`) returns `"company"` for Super Admin / CEO /
Finance Manager, `"team"`, `"hierarchy"`, `"line"` or `"self"` for everyone else — **never
`"system"`**. `"system"` only comes from `systemAccessContext`, the internal/cron context. So the
`scope !== "system"` half is unreachable from any HTTP request and the gate is plainly
**role === "Super Admin"**. The `sales:import` / `sales:export` assert underneath it never decides
anything. Verified 2026-08-21 by a 16-role local dev-auth sweep: Super Admin through on all 13,
every other role 403 on all 13 — including the CEO. Contrast the weekly module, which is
`weekly_sales:update` (Super Admin + SFE Manager) plus a CEO branch on the template route only —
see [[weekly-mapping-template-is-update-plus-a-ceo-exception]].

## Two routes write with NO input bail — never probe them as Super Admin

Every other route bails on `!(file instanceof File)` → 400 *"No file uploaded."*, or
`mappings.length === 0`, or `!distributorCode`, all of which sit after the gate and before any
write. These two do not:

- `mappings/learn-from-history` POST → calls `learnFromImportHistory()` straight after the gate.
  Upserts the alias tables from every `source_of_sales_import_rows` row.
- `brick-centroids` POST → calls `buildBrickCentroids()` straight after the gate.

`.env.local` points at **production** ([[local-env-already-points-at-production]]), so a Super Admin
probe against a local dev server is a real production write. Sweep them with the 15 non-admin roles
only and read the gate by inspection for Super Admin. `brick-centroids` **GET** is a read and is
safe (it returned `cached 1142 / success 949 / mismatch 13 / totalBricks 697` on 2026-08-21).

## 5 of the 13 have no access-registry entry

`src/lib/security/access-registry.ts` names only 8: `preview`, `download`, `import-validated`,
`mappings/{ai-suggest,bootstrap,learn,save,template}`. These fall through to the
`/api/sales/**` blanket — `sales:read`, **no audit classification**:

| Route | Writes? |
| --- | --- |
| `/api/sales/normalizer/import` | yes |
| `/api/sales/normalizer/brick-centroids` (POST) | yes |
| `/api/sales/normalizer/mappings/auto-map` | yes |
| `/api/sales/normalizer/mappings/learn-from-history` | yes |
| `/api/sales/normalizer/mappings/clusters` | no |

**Why:** this is an **audit** gap, not an access hole — each route's own hard Super-Admin check is
far stricter than the blanket's `sales:read`, so nobody gains entry. But four production-writing
routes leave no audit row, and the registry understates their real gate to anyone reading it.
`tests/access-registry-coverage.test.ts` does not catch them: it pins fall-through for exactly one
route (`mappings/save`, lines 59-61) and requires audit only on **export-like** routes (line 102),
so a mutation that falls through passes silently.

**How to apply:** the fix is registry entries with `audit.classification: "mutation"` and
`permission: { resource: "sales", action: "import" }` — matching each route's own assert — plus
widening the coverage test from the single `mappings/save` case to every normalizer route. The
registry already carries a comment (near line 646) about a route that "escaped the export-audit
guard twice over" by falling through, so this class of defect is one the repo treats as real. Not
yet done as of 2026-08-21; reported to the owner, not authorized.
