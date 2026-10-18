---
name: the-evidence-photo-is-the-primary-source-of-trust
description: "OWNER RULE 2026-10-18 — in ANY module holding a live evidence photo, the photo's own GPS/stamp outranks every declared or derived value (declared brick/area, inherited marketing label, typed address); never present a rep-typed or inherited territory as checked when the photo says otherwise."
metadata:
  node_type: memory
  type: feedback
  originSessionId: 22da81c5-3450-46a0-862f-073719430965
  modified: 2026-10-18T16:12:47.430Z
---

Owner, 2026-10-18, after Direct Order request 299304bf (حضانه عبد الكريم) showed brick منشأة سلطان / Menoufia 1 beside a photo stamped منوف / Menoufia 2: *"in any module that have an evidence photo your primary source of trust should be the photo of evidence."*

**Why:** the declared territory is a rep's typing or an inherited label (this venue's area came from the marketing customer's legacy `delta_1` = Menoufia 1, and its brick was the nearest centre INSIDE that area, 6.9 km off); the photo's pin is a measurement (0.7 km from منوف). The approval panel printed "nothing to check" on every territory row and never compared the declared place with the photo.

**How to apply:** read the photo's own territory FIRST in any panel, report or attribution that has one, and let a disagreement lead the sentence. Shipped for the Direct Order approval panel (`photo` block of `checkDirectOrderGeography`, brick centres via `resolveBrickForPoint`; a centre more than 15 km from the pin is "not usable", never an accusation). Also shipped the same evening, at his word: the marketing transfer files a venue's brick/area from the photo's pin (`applyPhotoPinTerritory`, pure, `src/lib/marketing-requests/photo-pin-territory.ts`), (first leaving a code-resolved venue alone, then including it once he ruled). The live nursery was re-pointed to منوف / Menoufia 2 (one row; 2 transfers exist, both now agree with their photos). Other photo modules (outstation, CRM visits) still to be read against this rule when touched. **RULED the same evening: "the photo wins everywhere, including where a distributor code exists"** — the transfer's code-guard is removed (PR in flight on branch codex/photo-wins-over-code), the old "registered code beats live GPS" line no longer applies to the transfer's filing; `venue-territory.ts` (a marketing customer's own area_id) still reads the code and was not changed. Writes that MOVE a venue's territory stay his decision (money-adjacent attribution).

Related: [[marketing-customers-belong-to-areas-not-people]] · [[marketing-system-validated-means-no-human-looked]]
