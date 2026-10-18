---
name: a-pharmacy-is-findable-through-two-rows-and-marketing-also-needs-field-capture
description: "To make a distributor pharmacy findable, add ONE source_of_sales_customer_map row (the Direct Orders picker reads it) AND ONE marketing_pharmacy_code_references row (the marketing \"known code\" flag and code picker read it); a marketing REQUEST can still only pick a pharmacy a rep captured with GPS and a live photo, so never fake that."
metadata:
  node_type: memory
  type: reference
  originSessionId: 5f26fea1-aed6-46a3-ae7a-e27489f10903
  modified: 2026-10-18T12:56:14.834Z
---

Done once on 2026-10-18 (about 15:55 Cairo) for Overseas (`PS`) code 1549597, "محمود علي محمود احمد", El Maqatla village, Tamiya, Fayoum — the owner handed the name, code and address from a distributor receipt dated 2023-12-24 and asked that Direct Orders and Marketing Requests find it.

- **Direct Orders** — `phx_search_direct_order_customers` reads `source_of_sales_customer_map` (source `directory`) and `direct_order_pharmacies`. One map row is enough: found by code and by name, proven by calling the function. The brick came from the address: the word طامية is an alias for the Tamiya brick, and five other El Maqatla customers already sit in it. Written at confidence 90 (inferred), `mapped_by` B-10, source `owner-added-from-receipt-2026-10-18`; confidence 100 is only for a ruling of his own.
- **Marketing code check and picker** — read `marketing_pharmacy_code_references` (distributor id 19 = "POS", the marketing name for Overseas), NOT the customer map. The picker takes the NAME from the map by exact code, so store the reference code spelled exactly like the map row. Insert region and area as the governorate and town names (الفيوم, طامية): the ranking and `checkCapturedGovernorate` compare names, and a code like GZ6 is read as "not comparable". `normalized_pharmacy_code` and `compact_pharmacy_code` are GENERATED — never insert them.
- **A marketing request still cannot pick the pharmacy** until a rep captures the venue (GPS plus a live photo). Never create `marketing_pharmacies` or `marketing_customers` rows by hand to get around it: that is fabricated field evidence.
- **Zero padding.** Overseas sales files print codes padded to 10 digits (`0001549597`, all 30,388 distinct 15xxxxx codes in import rows); the receipt prints 7 digits. The marketing check handles both (exact, then compact). The sales importer places an unmapped code by its district text, so nothing breaks, but the padded spelling may later appear as a second map row.
- `phx_sync_sales_pharmacy_codes_into_marketing` copies map codes into the references table only when neither the exact nor the compact code is there, so a hand-added reference row is never duplicated by it; its retire pass touches only rows whose `source_file` is `source_of_sales_customer_map`, which is why the hand row uses its own source name.

Related: [[marketing-not-found-codes-have-three-root-causes]], [[pos-pharmacy-codes-are-zero-padded]], [[marketing-transfer-writes-no-distributor-link-when-the-code-is-unresolved]].
