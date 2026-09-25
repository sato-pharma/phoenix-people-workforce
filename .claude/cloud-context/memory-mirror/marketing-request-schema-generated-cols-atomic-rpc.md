---
name: marketing-request-schema-generated-cols-atomic-rpc
description: "marketing_requests/_products have GENERATED ALWAYS cols (never insert them); pharmacy_id is a NOT-NULL landmine; bulk import now uses the atomic RPC import_marketing_request_atomic."
metadata: 
  node_type: memory
  type: reference
  originSessionId: a92a7163-f2b7-4768-977a-f47b95254a35
---

Live schema facts for the marketing-request tables (verified on staging + prod 2026-07-04),
and the bulk-import atomicity change (PR #801).

**GENERATED ALWAYS columns — never INSERT them (raw SQL raises "cannot insert a
non-DEFAULT value"; PostgREST silently strips them, which hid this):**
- `marketing_requests.required_roi_value`
- `marketing_requests.roi_coverage_ratio` (= expected_roi_value / required_roi_value)
- `marketing_request_products.expected_value` (= factory_price × forecast_qty)
The DB derives all three. The old `executeBulkImport` "inserted" them but PostgREST
dropped them; a raw-SQL RPC must omit them explicitly.

**pharmacy_id landmine:** `marketing_request_pharmacies.pharmacy_id` is NOT NULL with
no default and **no trigger** — yet the bulk-import JS only ever set
`(request_id, distributor_code_id, tracking_status)`. So any bulk import with a
non-empty resolved-pharmacy set fails that row (pre-existing; the pharmacy path is
effectively dead in bulk import). Out of scope for the atomicity fix — replicated
faithfully so such a row now fails ATOMICALLY.

**All 3 child tables cascade on `request_id` delete** (products, pharmacies,
approval_steps → marketing_requests ON DELETE CASCADE).

**Atomic bulk-import RPC (live in staging+prod):**
`public.import_marketing_request_atomic(p_request jsonb, p_products jsonb,
p_pharmacies jsonb, p_steps jsonb) returns uuid` — security-definer plpgsql,
service_role only. Inserts request + children in one transaction (all-or-nothing
**per row**, NOT whole-batch — the UI reports per-row imported/failed). JS still
computes value_share/ROI and marshals JSONB payloads in. Replaced the old
four-insert + best-effort parent-delete (whose swallowed error could leave partial
data). Related: [[marketing-requests-prod-wipe-restore]] (the "skip generated cols"
lesson), [[supabase-dual-project-schema]].
