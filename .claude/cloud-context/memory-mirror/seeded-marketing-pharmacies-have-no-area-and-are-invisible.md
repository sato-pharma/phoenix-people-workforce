---
name: seeded-marketing-pharmacies-have-no-area-and-are-invisible
description: "Marketing visibility for BOTH customers and pharmacies is TERRITORIAL (area_id), not ownership — canSeeMarketingCustomer / canReuseMarketingPharmacy match on hierarchy OR row.area_id == viewer's employees.area_id. So owner_hr_id does NOT grant sight and a NULL owner does not hide; a row with an area_id is already visible to every rep on that patch. The trap: a row with area_id NULL (every 2026-07-02 seed) is invisible to every rep — fix a stuck row by backfilling area_id ONLY, never owners. Deriving the area: the registered distributor CODE wins over GPS/customer, but only when it resolves; when it doesn't, source_of_sales_bricks is the authority, never the coordinates."
metadata:
  node_type: memory
  type: project
  originSessionId: da5b316c-c6c1-4593-abd2-1ff2cab200e2
  modified: 2026-09-26T00:22:51.000Z
---

## The visibility rule

`canSeeMarketingCustomer` and `canReuseMarketingPharmacy` (`src/lib/marketing-requests/service.ts`) are
the **same predicate**, for customers and pharmacies alike:

1. hierarchy on `owner_hr_id` / `manager_hr_id`, **OR**
2. `row.area_id === viewerAreaId`, where the viewer's area is `employees.area_id`.

Branch 2 is the owner's 2026-08-19 ruling — *"they must be assigned to areas, because the employee
resigns and another is hired in his place, and he finds his customers automatically"* — and it is
deliberately **line-agnostic** ([[marketing-customers-belong-to-areas-not-people]]).

**So `owner_hr_id` does NOT grant sight of a row, and a NULL owner does not hide one.** A row with an
`area_id` is already visible to every rep on that patch. **Never "fix" a stuck marketing row by
backfilling owners** — that is the busywork the ruling abolished; it changes nothing.

**The real trap: a NULL `area_id`.** The app always writes `area_id` on capture; a seed/backfill may
not. With `owner_hr_id`, `manager_hr_id` **and** `area_id` all NULL, both branches fail — the row is
invisible to **every** rep, and only a `scope === "system"` viewer (Super Admin) sees it. Missing AREA,
not missing ownership, is why such a row cannot be worked.

## Making a row workable — backfill `area_id` ONLY

Do **not** invent `line_id` (line-agnostic; one shop serves every line) and do **not** invent
`owner_hr_id` (it is the audit record of who actually captured — the app stamps it at capture time).
Backfill only `area_id`, and require it to agree with the linked customer's own `area_id` before writing;
roughly **1 in 5 seeded shops has a code that contradicts its customer's area**, so never blanket-apply a
code's area without the agreement test. The proven decision procedure, most-confident first: both sources
agree → use it; only one source available → single-source infer; the two contradict → **the code wins**
(below). Give each write a distinct `validation_notes` prefix so confidence stays auditable and each tier
is separately reversible (every target was NULL beforehand, so undo is exact per prefix).

## Deriving the area — the code-wins rules

- Derive the area from `marketing_pharmacy_distributor_codes.mapped_area_code` (master-map resolved), and
  resolve the patch directly with **`areas.code = mapped_area_code`**. 🔴 **The letter prefix is the
  REGION, the whole code is the AREA** — `GZ5` is Helwan-Maadi, not Giza — so always resolve a code
  through `areas.code` before calling anything a conflict.
- 🔴 **OWNER RULE 2026-08-21 — when a shop's REGISTERED DISTRIBUTOR CODE disagrees with its GPS /
  Google-resolved area, the CODE WINS**, even over a live capture GPS (asked directly, answered
  *"registered distributor code"*). Measured basis: against the `captured_address` of coded app-captured
  shops the code's area matched the real address **14 of 15**. The customer's `area_id` is where the
  **doctor** practises; the code describes the **shop**, and a doctor legitimately sends scripts across an
  area boundary, so a contradiction is usually not an error at all.
- 🔴 **But the code only decides when it actually RESOLVES. When it doesn't, the authority is
  `source_of_sales_bricks`, NOT the GPS** ([[sos-bricks-are-the-authority-for-branch-to-area]]). **Query
  the brick table before inferring an area from coordinates** — a shop's town can sit in a different sales
  area than the nearest city suggests (قطور/Kotour resolves to `D15` Gharbia 2 / Mahalla, not the `D14`
  Tanta its GPS and a sibling shop suggested). **The sibling-shop shortcut is not evidence** — two shops
  in one town can carry codes that resolve to different areas, and the code-wins rule leaves each standing.

## Traps when resolving and retiring

- **Do NOT validate a captured pharmacy's area against `marketing_pharmacies.area_id`.** That column is
  the **capturer's own `employees.area_id`**, which is a PATCH for a rep but a **REGION for a manager** —
  so captured rows hold values like `Egypt`, `Cairo`, `Giza`, `Delta (1)`. A naive compare reports
  region-vs-patch "disagreements" that are the same place at two hierarchy levels. Compare against
  `captured_address` / `extracted_governorate_name`. (This is why manager-captured shops get retagged
  region→patch.)
- **`NULL` vs `'unresolved'` is load-bearing:** `NULL` = the resolver never ran; `'unresolved'` = it ran
  and found nothing (the shop has no sales history under that code in `source_of_sales_customer_map`).
  **Never fabricate a master mapping to clear an `unresolved`.** The resolver is
  `public.phx_resolve_marketing_pharmacy_codes(p_code_ids uuid[])` — SECURITY DEFINER, idempotent, safe on
  an explicit id list; **never pass NULL** (it re-verdicts all ~317 codes).
- **`marketing_pharmacy_distributor_codes` joins on `pharmacy_id` directly, not only through the link's
  `distributor_code_id`.** Resolving codes only via the link hides a code area on pharmacies that have no
  link — they look unresolvable. Always join by `pharmacy_id` when asking "what area is this shop in".
- **Retiring a pharmacy must also deactivate its `marketing_pharmacy_distributor_codes` rows**, or a live
  code stays registered to nothing ([[customer-pharmacy-link-grain-is-customer-plus-code]]). After any
  retirement re-run the three counts: 0 live codes on dead pharmacies, 0 live links on dead pharmacies,
  0 live links on dead customers.

## What a backfill does and doesn't do

A wrong area is caught **at capture time** by the blocking governorate check (#2231, capture vs the code's
registered region) — which is what makes a single-source `Area inferred` write acceptable, since
invisible-to-everyone is strictly worse. **Granting visibility is not forging evidence:** both halves of a
link still need a real photograph to promote, and a backfill promotes nothing
([[marketing-link-status-is-frozen-at-write-time]], [[marketing-links-were-backfilled-from-a-sheet-not-the-database]]).
Codes are not geographic in themselves ([[pharmacy-code-numbers-are-not-geographic]]) — it is the
master-map-resolved area that carries the authority.
