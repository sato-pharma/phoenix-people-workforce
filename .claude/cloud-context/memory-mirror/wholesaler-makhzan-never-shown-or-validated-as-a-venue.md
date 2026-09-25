---
name: wholesaler-makhzan-never-shown-or-validated-as-a-venue
description: "A distributor's wholesaler/makhzan is never shown as a candidate nor accepted in marketing-request or direct-order venue validation — hard-block certain warehouses, flag ambiguous فارما."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: a081c2b1-71e5-4088-ae1e-6dd8a0b76877
  modified: 2026-09-22T15:05:22.112Z
---

Owner rule, 2026-09-22 (emphatic — "never never never"): in **marketing-request AND direct-order venue validation**, a **wholesaler / makhzan** (a distributor's own warehouse) must NEVER be shown as a matchable candidate and NEVER accepted or validated as a venue. It is not an end customer — validating one mis-credits its sales to a warehouse.

**Why:** there is NO makhzan flag in the data — venue types are only pharmacy/nursery ([[src/lib/venues/venue-type.ts]]) and neither reference table has a customer-type column. The monthly closing already answers "is this a wholesaler" by NAME (`isStoreCustomer` in [[src/lib/sales/customer-channel.ts]]), so a makhzan is detectable only from `customer_name`.

**How to apply:** the guard lives in its OWN venue-only module `src/lib/venues/wholesaler-venue-guard.ts` — it IMPORTS the closing's pure primitives and never edits `customer-channel.ts` (closing numbers untouched; the one enabling change was exporting `matchesAnyName` as pure `nameMatchesAnyKeyword`, no behaviour change). **Two tiers** (owner decision, asked in chat, "block certain, flag فارما"):
- **HARD-BLOCK** `isCertainWholesalerVenue(name, code?, dist?)` — مخزن·جملة·trade phrase (لتجارة وتوزيع الأدوية)·QM wholesale-only distributor·«م - » prefix·named roster·code-keyed store override. Dropped from every picker AND refused at every write path. Pharmacy overrides (مخزن الطرشوبى) win first.
- **FLAG ONLY** `suspectedWholesalerFlag`/`suspectedWholesalerNote` — a bare «X فارما»/الشركة/الجمعيه/تريد. NEVER refuses; a real retail pharmacy can be branded "Pharma" and a false positive must never silently refuse one. System flags, human decides.

مخزن/جملة are venue-only, deliberately NOT added to `customer-channel.ts` (the closing excludes bare جملة and treats the plural مخازن as a government depot / protector). **Deliberate deviation:** `listMarketingVenueMergeCandidates` (Super-Admin duplicate-cleanup) is NOT filtered — hiding wholesalers there would remove the only way to RETIRE an existing wholesaler row.

**Blast radius (prod, read-only, 2026-09-22):** DO has ONE human-validated makhzan `مخزن نيو سيتي` (owner unwinds on its own screen; nothing auto-un-validates). Marketing has ZERO human-validated wholesalers — the certain/suspected names carry only `system_validated` links. Pinned by `tests/wholesaler-venue-guard.test.ts`. Rule home: AGENTS.md §4.1 + [[venue-validation-rule-gps-photo-then-code-or-licence]].
