---
name: city-split-hides-same-city-customer-moves
description: "Because Phoenix spreads every wholesaler evenly across its city's areas, moving a customer between two areas of the SAME city changes the closing by exactly zero — measured, not assumed — but that stops being true under the value-share Office rule"
metadata: 
  node_type: memory
  type: reference
  originSessionId: cfb1b008-82c7-4a44-b3f1-382f5e0f94a9
  modified: 2026-09-15T13:37:11.759Z
---

🔴 **FLIPPED BACK — verified on `origin/main` 2026-09-15: the city split is ON again.**
`src/lib/sales/store-sales-city-split.ts` has `STORE_CITY_SPLIT_ENABLED = true` and
`STORE_CITY_SPLIT_FROM_PERIOD = "2026-08"`, and AGENTS.md §4 holds it as THE CITY RULE ALWAYS WINS.
The 08-12 paragraph below is history: it was true for July-era code only. From August a same-city
customer move is again re-spread across that city's areas.

**THE PREMISE HAS FLIPPED — verified on `origin/main` 2026-08-12.** The city split is **OFF**:
`93b384e4` (#2015) turned it off along with shipping the value-share Office rule, and `3ece2049`
(#2042) turned it off *"for real (lost in a squash)"*. So the headline below — "a same-city customer
move changes the closing by exactly zero" — describes the **pre-#2015 engine only**. Today a
placement fix moves the closing twice: on its own units AND through the Office value share. The
INVERSION warned about at the bottom of this file **has happened**; read it as current, not
hypothetical. Everything else here is kept because the measurements are the evidence for why.

Measured on live production 2026-08-10 while chasing the CNS July area gap. This killed three
"fixes" that looked obviously right.

Applying **every** reverted customer ruling (1,455 units re-pointed) moved the 35-area closing by:

| | Before | After |
| --- | --- | --- |
| Net gap vs the owner's sheet | +1,563 | +1,558 |
| Absolute error across 35 areas | 16,935 | 17,180 (**worse**) |

Only two areas changed at all. **Why:** nearly every ruling moves a customer between two areas of
the same city — Sohag1↔Sohag2, Alex East↔Alex Center, Assiut 1↔2, Qena 1↔2, Menoufia 1↔2 — and
[[store-sales-split-evenly-across-city-areas]] already divides a wholesaler evenly across its
city's areas, so the origin area is irrelevant. Same reason booking the EZ wholesaler to Heliopolis
instead of Nasr City moves the closing by **exactly 0**: both are Cairo, so its 2,650 units are
re-spread across all six Cairo areas either way.

**What actually moved the gap** (same measurement, cumulative):

| Change | Abs error | Delta |
| --- | --- | --- |
| as-is | 16,935 | — |
| apply every reverted ruling | 16,935 | **0** |
| book the EZ wholesaler to Heliopolis | 16,935 | **0** |
| place Office by the owner's value-share rule | 10,860 | **−6,075** |
| …and stop splitting wholesalers across their city | 6,062 | −4,798 |

So the area difference between the two sheets is **rule differences, not data errors** — and the
owner's sheet does not apply the city split at all.

**THE INVERSION — this is the part to remember.** Under
[[owner-office-allocation-rule-value-share]] a customer's area feeds the value share that places
**42,838 Office units (41% of the line)**. The moment that rule ships, every placement that is
invisible today starts dragging Office units with it — the EZ wholesaler alone swings ~1,516 Office
units on top of its own 2,650. **Settle customer placement BEFORE shipping the Office rule**, or the
new rule faithfully amplifies every misplacement.
