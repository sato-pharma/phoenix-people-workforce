---
name: the-normalizers-place-match-can-name-a-brand-not-a-place
description: "A `source: \"place\"` suggestion at confidence 95 can be matching the pharmacy's BRAND name, not its location — عابدين Pharm in Sohag was suggested for عابدين, Down town Cairo (B25-41), against its own filed address مدينة سوهاج."
metadata:
  node_type: memory
  type: project
  originSessionId: d5764c39-c02c-4dd4-a40d-70ad08cc490c
  modified: 2026-10-09T22:28:48.955Z
---

Read the `source` field on a `HoldSuggestion` before acting on its brick, and check it against the
distributor's own `filedAddress`.

Hold 3500 on production, 2026-10-10: customer `احمد عزت فهمى - مجموعه صيدليات عابدين فارم`
(RM / 22050133), filed `Sohag1 · مدينة سوهاج` (B213-1, area UE5, region UE), the held change wanted
`Sohag2 · المنشأه` (B165-1, UE6), and the normalizer suggested **`عابدين — Down town, Cairo`
(B25-41, area CA5, region CA) via `place`, confidence 95**. The name عابدين in that pharmacy is the
CHAIN's brand; the distributor's own filed address for the same month reads
`ميدان العروبه الملاحه الجديدة - مدينة سوهاج`. Taking the suggestion would have carried
**3,034.34 EGP** of tracked sales (3,142.34 in 2026-09, −108 in 2026-03) out of Upper Egypt into
Cairo.

- **`source: "address"` is the trustworthy one** — the two Alexandria holds the same night
  (3571/3495, B153-4 → B151-2) were address-derived, stayed inside area AB3, and moved no area money
  at all.
- **`source: "place"` is a name match** and can collide with a brand, a person or a street. The
  decisive test is the same one as [[a-villages-town-is-read-from-its-neighbours-bricks]]: the filed
  address and where the neighbouring map rows sit, never the name alone.
- A `place` suggestion that crosses REGION (UE → CA here) against a filed address naming the current
  region is a false positive, whatever its confidence says.

Related: [[the-sohag-brick-structure-is-correct-as-it-stands]].
