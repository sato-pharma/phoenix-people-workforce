---
name: customer-pharmacy-link-grain-is-customer-plus-code
description: "marketing_customer_pharmacies is unique on (customer_id, distributor_code_id), NOT (customer_id, pharmacy_id) — so one customer+pharmacy pair legitimately has several link rows and they are not duplicates."
metadata: 
  node_type: memory
  type: project
  originSessionId: da5b316c-c6c1-4593-abd2-1ff2cab200e2
  modified: 2026-08-20T22:12:21.639Z
---

`marketing_customer_pharmacies` carries a real unique index:

```
marketing_customer_pharmacies_unique ON (customer_id, distributor_code_id)
```

**The grain is one link per customer per DISTRIBUTOR CODE.** A pharmacy that carries two distributor
codes therefore produces **two link rows for the same customer + same pharmacy**, and both are
correct. Verified on production `ozucdzovmcqvepbozvqf` 2026-08-21.

**Why:** a deep audit on 2026-08-21 ran a duplicate check grouped on `(customer_id, pharmacy_id)`
and reported "6 duplicate active links". The owner approved retiring four of them. They were not
duplicates — each pair held two different codes (`333525`/`1560637`, `330340`/`1503246`,
`1507381`/`358838`, `421516`/`1511327`), and deactivating one of each would have silently deleted a
live distributor-code mapping from a working customer. Caught only by selecting
`distributor_pharmacy_code` alongside the pair before writing. Production has **zero** duplicate
links.

**How to apply:** never group this table on `(customer_id, pharmacy_id)` to find duplicates — group
on `(customer_id, distributor_code_id)`, which is what the index enforces. More generally, before
calling rows redundant, project the column the unique constraint actually names; read
`pg_indexes` for the table rather than assuming the natural key. Retiring a link is a soft delete
(`active = false`) so it is reversible, but the mapping it carried is invisible to the request
dropdown the moment it flips. See [[a-write-revoke-does-not-stop-a-cascade-or-a-secdef-function]]
for the sibling lesson about trusting a believed constraint over the declared one, and
[[cross-line-shared-customers-are-never-reassigned]] for why a shop reachable two ways is normal
here, not a defect to clean up.
