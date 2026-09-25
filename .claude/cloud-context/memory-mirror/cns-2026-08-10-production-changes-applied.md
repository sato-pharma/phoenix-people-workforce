---
name: cns-2026-08-10-production-changes-applied
description: "What was actually written to production on 2026-08-10 chasing the CNS July gap — the Rispadex UPA re-mapping and the 68 reverted customer rulings — so a later session does not redo or undo it"
metadata: 
  node_type: memory
  type: project
  originSessionId: cfb1b008-82c7-4a44-b3f1-382f5e0f94a9
  modified: 2026-08-10T11:47:15.819Z
---

All applied to production `ozucdzovmcqvepbozvqf` on 2026-08-10, owner-instructed, each verified
through `phx_monthly_closing_matrix` and not just the tables. **CNS line totals never moved.**

**1. Rispadex UPA re-mapping** (see
[[owner-sheet-vocabulary-stores-is-office-upa-is-a-channel]])

- 5 aliases re-pointed **RI002 → RI001**: EG-HOS `10409`, `Rispadex 3 mg`,
  `RISPADEX FILM C.TABS 3 MG 30`; SF-T `Rispadex 3 mg`, `RISPADEX  3 MG. 30 TAB(T)`.
- **135 rows / 15,935 units** re-stamped across Jan/Apr/May/Jun/Jul; `value` re-based 34.425 → 35.70.
- 8 batches refreshed via `phx_refresh_sos_fact_rollup` + `phx_refresh_sos_customer_directory_rollup`.
- Result July: RI001 **0 → 4,545** (owner's sheet: 4,545), RI002 **9,693 → 5,148** (his: 5,146).
  May 8,257 · Jun 4,511 · Jan 82 (Jan is 132 minus a pre-existing PS-T return of −50 already on RI001).
- **IS-T's 500 units stayed on RI002** — matches his sheet; he has not ruled on it.

**2. 68 reverted customer brick rulings re-applied**

`resolveBrick` had let re-imports overwrite them. Repaired: **408 rows / 1,532 units, 66+2
customers, all 7 periods**, `customer_map` ruling copied onto `import_rows`
(brick_id, area_code, region_code) then rollups refreshed. The ruling canary went **416 → 2 rows**.
The 2 left are client `22199672` — blocked by
[[epda-reuses-one-client-code-for-two-pharmacies]].

Also: `434921 الصيادلة فارم` re-pointed to brick **B165-3 جرجا / UE6 Sohag2** (owner's ruling,
`source='owner-ruling-girga-sohag2-2026-08-10'`) — 71 rows / 4,481 units. It had been on B166-1
دار السلام with July's IS rows reverted to B213-1 / UE5.

**Do not expect this to have closed the gap with his sheet** — it barely moved, by design:
[[city-split-hides-same-city-customer-moves]].

**Still open at end of session:** the Office value-share rule is specified and validated but NOT
built; the nine wrong CNS factory prices are untouched (owner said leave them); `resolveBrick`
itself is unfixed so the next re-import reverts these rulings again; the canary is still
narrow in the repo docs.

**Not mine:** Pedia July moved 10,764 → 11,264 mid-session (another session booked 500 Ivyronc
direct). Verified consistent — the overlay in `july-2026-direct-orders.ts` totals 1,208,548.15 =
Pedia 1,059,259.65 + Anti Infective 149,288.50, so the area-detail guard still passes.
