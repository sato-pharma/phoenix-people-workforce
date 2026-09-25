---
name: duplicate-pharmacy-test-is-name-and-gps-not-brick
description: "Brick and area are far too coarse to detect a duplicate pharmacy — use display name plus GPS distance plus shared distributor codes."
metadata: 
  node_type: memory
  type: project
  originSessionId: da5b316c-c6c1-4593-abd2-1ff2cab200e2
  modified: 2026-08-21T00:09:32.916Z
---

**Never decide "is this the same pharmacy" from area or brick.** A brick is a whole town: البدراشين
is ONE brick (area `GZ1`, region `GZ`), so two *different* shops 52 m apart on the same street share
it. `marketing_pharmacies` has no brick column at all, and `public.geo_bricks` — the only table with
brick coordinates — is **empty (0 rows)**, so no point-in-brick test exists to write.

**The test that actually works**, all three together:

1. `display_name` — Egyptian pharmacies are named for their owner. عمرو vs هبه خالد is two shops,
   full stop. A spelling variant ("Tabark hospital" / "Tabarak hospital pharmacy") is one shop.
2. GPS distance between `captured_latitude`/`captured_longitude`, compared against the sum of both
   `captured_accuracy_meters`.
3. **Shared distributor codes — the strongest signal.** Two distinct shops do not share both an
   Ibn Sina code and a POS code. This is what proves a merge when the GPS disagrees: المصريه الجديده
   and سامي each read 144 m apart yet were one shop, because a rep captured two shops from one
   standing position.

**A SHARED DOCTOR IS NOT A SIGNAL — it is the normal case.** Owner's rule, 2026-08-21: *"maybe same
dr have more than 1 ph around him."* A doctor's scripts get filled at every pharmacy near his clinic,
so two pharmacy records linking to the same customer says nothing about whether they are one shop.
Measured on production the same day: of **161** active customers carrying a link, **73 (45.3%)** have
more than one pharmacy — 44 have exactly two, 13 have five or more, and one doctor has **eight**.
Average 1.91. Do not add "shares a customer" to the test above; it would merge real shops.

**Why:** deciding on brick alone would have deleted a real pharmacy (عمرو/هبه خالد, 2026-08-19), and
treating a shared doctor as evidence would have merged مستشفي/مستشفى فيكتوريا — two POS accounts on
two different Victoria streets — in 2026-08-21. See
[[duplicate-customer-scan-misses-transliteration-and-cross-line]].

**How to apply:** run all three, and treat a name mismatch as disqualifying no matter how close the
GPS is. When one code sits on two differently-named shops, **flag both records in
`validation_notes` — never merge and never pick a winner yourself**; only the rep who stood in the
shop knows which owns it. That follows [[system-flags-expenses-never-rejects]].

**Lookup trap:** POS codes are zero-padded to 10 digits, so probing
`marketing_pharmacy_code_references` for `1501992` returns nothing while `0001501992` is the stored
form — `ltrim(regexp_replace(code,'\D','','g'),'0')` on **both** sides. Also
`marketing_pharmacy_distributor_codes.normalized_pharmacy_code` is only zero-padded **when the
reference match succeeded**; on a `not_found` row it holds the raw digits, so it is not a reliable
join key. See [[pos-pharmacy-codes-are-zero-padded]] and
[[marketing-reference-list-is-a-point-in-time-import]].

Related: [[marketing-pharmacy-duplicate-merge-applied-2026-08-19]]
