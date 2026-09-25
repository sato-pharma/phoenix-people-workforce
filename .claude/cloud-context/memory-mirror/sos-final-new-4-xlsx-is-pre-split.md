---
name: sos-final-new-4-xlsx-is-pre-split
description: "FINAL NEW (4).xlsx is a PRE-split SoS master — applying it wholesale would delete OT4–OT10, 98 blocks, 196 bricks and all IMS ratios"
metadata: 
  node_type: memory
  type: project
  originSessionId: 47a721ae-e4ae-42e3-ae5a-303c30a10d5e
  modified: 2026-07-28T17:00:27.074Z
---

2026-07-28: owner asked to drop all bricks/blocks and make `C:\Users\satoh\Downloads\FINAL NEW (4).xlsx`
the only source of truth. **Blocked — the file is a strict SUBSET of live, not a replacement.**

Measured against PROD `ozucdzovmcqvepbozvqf`:

| | Live | File | Effect of blind replace |
| --- | --- | --- | --- |
| areas | 49 | 42 | −7 (OT4–OT10) , 0 new |
| blocks | 220 | 122 | −98, 0 new |
| bricks | 784 | 597 | −196, **only +9 new** |

Proof it predates the 07-27 Others split ([[sos-others-region-split-2026-07-27]]): the file's
`OT3 "Aswan"` still holds all 14 bricks that live has redistributed — B134→OT4 New Valley,
B142→OT5 Hurgada, B145/B146→OT6 Luxor, B147/B148→OT7 Aswan, B168/B169→OT8 Red Sea; and
B121→OT9 Ismailia (file has it under OT1), B123→OT10 South Sinai (file has it under OT2).
Live `OT3` is now `Aswan (Legacy)` with **0 bricks**. The `(4)` suffix suggests a re-download of
the same master already applied on 07-27.

Other blockers found:
- **IMS Ratio column is 100% empty** (all 597 cells). Live has 39/49 areas populated (0.0067–0.0474)
  — a wholesale replace nulls them. See [[sos-ims-ratio-storage]].
- **No brick-alias table exists.** Aliases exist for area/product/region/territory only, so
  "any other brick becomes an alias" has no mechanism — needs a new table + a 196-row old→new
  crosswalk only the owner can validate. Contradicts [[sos-owner-standing-rules-from-session-369dd08d]].
- `source_of_sales_customer_map`: 49,712 rows; **2,521 rows across 132 bricks would be orphaned**.
  All SoS sales/fact tables are currently EMPTY ([[sos-sales-purged-for-fresh-upload-2026-07-28]]),
  so sales attribution is not at risk — mapping is the only populated dependent.

Delivered `C:\Users\satoh\Downloads\OT4-OT10 SPLIT - ready to paste.xlsx` (21 rows, file's exact
7-column layout + a WHAT_CHANGED sheet) so the owner can repair the OT section of their master.
`B121-M1` exists in the file but not live; placed into OT9 by inference from its block — unconfirmed.

**How to apply:** never accept a "this file is now the only source of truth" master without first
diffing it against live counts per level. A master that adds ~0 areas/blocks is a re-export of an
older state, not a new spec.
