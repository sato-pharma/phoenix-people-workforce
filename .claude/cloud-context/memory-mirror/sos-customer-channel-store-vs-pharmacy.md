---
name: sos-customer-channel-store-vs-pharmacy
description: "SoS customers split into Stores vs Pharmacies by six Arabic name keywords, derived at read time — one constant re-classifies all history."
metadata: 
  node_type: memory
  type: project
  originSessionId: f92f2e0d-b5e9-4641-858a-f7863f7ea89a
  modified: 2026-08-04T08:47:26.939Z
---

Owner rule, 2026-08-04: a Source-of-Sales customer whose NAME contains **مخزن، فارما/فارم، تريد،
الشركة، الجمعيه، للتجارة** is a **STORE** (wholesaler / warehouse / trading company); everything
else is a **PHARMACY**. Purpose: attribute sales to the two channels.

Lives in `src/lib/sales/customer-channel.ts` — `STORE_NAME_KEYWORDS` is the single edit point.
Surfaced as the **Customers** tab in `SalesImportWorkspace` (Pharmacies | Stores sub-tabs), fed by
`/api/sales/customer-directory/by-channel`.

**Why it is derived at read time, not stored:** the owner said future historical uploads will keep
arriving with these names. Deriving from the name on every read means a new sheet classifies the
moment it lands — no backfill, no migration, no stored column to drift. Adding a word to the
constant re-classifies the entire history.

**How to apply:**
- Measured on production 2026-08-04: **473 stores / 48,727 pharmacies**; stores are
  125.3M of 303.7M EGP (~41%) on far fewer customers.
- The directory RPC **recomputes** value as Qty × live factory price × (1 − discount), so its
  channel totals differ slightly from summing the stored sheet `value` (125,327,598 vs
  125,440,939). The RPC figure is the authoritative one.
- Matching is SUBSTRING and orthographically folded — see
  [[arabic-name-search-needs-orthographic-normalization]]. `فارم` is a prefix of `فارما`, so the
  short stem covers both.
- **`شركة` without `ال` is deliberately NOT a keyword** — "شركه أيه ام جروب" (3.4M EGP) sits in
  Pharmacies on purpose. ~360 customers match near-variants (مخازن, شركة/جمعية without ال, تجارة
  without لل, latin PHARM). The owner has not ruled on those yet.
- One known false positive: "ابراهيم / ارض الشركه -الشرابية" — ارض الشركه is a place name.
- Channel totals are summed BEFORE the 2000-row display cap, so a channel figure never silently
  means "the first page" ([[no-data-must-never-render-as-absence-or-zero]]).
