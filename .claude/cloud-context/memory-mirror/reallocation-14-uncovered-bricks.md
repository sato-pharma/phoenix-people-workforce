---
name: reallocation-14-uncovered-bricks
description: "The 14 live bricks the 668-brick reallocation plan didn't cover are RESOLVED and APPLIED to production 2026-07-24 (3 blocks + 16 bricks inserted, 14 deactivated) — do not re-audit them as open. The ONE live open item: customer_map is STALE for those 14 old ids, so their customers stop resolving in monthly imports until remapped. The wider 668/168 plan itself is still PAUSED. Holds the per-LINE region data fact and the relayed-classification / owner-ground-truth lessons."
metadata: 
  node_type: memory
  type: project
  originSessionId: 13d2cbc9-99e8-4d8f-b6cc-e899420ca975
  modified: 2026-09-26T11:08:55.203Z
---

The 14 live production bricks that the 674→668 reallocation plan (`Locked_Area_Brick_Block_Reallocation.xlsx`)
did not address were **RESOLVED and APPLIED to production 2026-07-24** — do NOT re-audit them as open. All 14
fold into the live 668-brick set: 3 new blocks (B149/B156/B157) + 16 new bricks inserted, the 14 old bricks
deactivated (`active=false`), tagged `source_file = 'manual:14-uncovered-bricks-resolution-2026-07-24'` with
3 `audit_logs` rows (raw `execute_sql` bypasses the app's own `writeAuditLog`). 12 were direct
reallocations, B106-79 merged into B5-64 (Heliopolis — owner override), B25-43 (a legacy catch-all) split by
address across Badr/Sadat/Kom Hamada/Buraijat.

🔴 **The one live open item: `source_of_sales_customer_map` is STALE for those 14 old brick ids.** Only the
brick/block structure was applied; the CUSTOMER moves (the B25-43 split and the direct-reallocation customer
remaps) are NOT applied, so customers still on the 14 old ids **stop resolving in the next monthly import
until remapped** — deferred until the owner says go on customers. (The B25-43 split proposal lived in a
scratchpad CSV that may be gone; scratchpad contents are not durable within a long session —
[[localappdata-temp-is-live-tool-state]].)

**The wider 668/168-brick reallocation plan is still PAUSED and NOT applied** (gated on an explicit "ابدأ");
only this 14-brick fix landed. Live counts are ~441 bricks / ~151 blocks today, NOT the 668/168 eventual
target — do not conflate today's live count with the full plan's target. (The live block count was already
higher than the plan's "142→168" headline assumed, so prior legitimate manual block edits exist; verify block
counts against live, never against the plan's headline.)

## 🔴 The per-LINE region data fact (any master-data deliverable must reflect it)

`au.line_area_map` implements a genuine per-LINE operational region grouping over the same 42 areas — CNS,
Pedia and Anti-Infective each carry their own region assignment, and **16 of the 42 areas DIFFER by line**
(CA5, D11, D16, D25, GZ3, GZ5, GZ6, GZ7, and all 8 UE areas). It is NOT just the well-known UE→UE-1/UE-2
Anti-Infective split — e.g. GZ6 (Fayoum-Beni Suef) is OT for CNS, GZ for Pedia, UE-1 for Anti-Infective; CA5
(Downtown) is GZ/OT/OT across the three lines, so its base region code (CA) matches NONE of its per-line
regions. **A single flat Area-Master `region_code` is a real, already-hit confusion risk — read anything
line-scoped from `au.line_area_map`, never the Area Master's own region_code.** [[area-unification-42-areas-design]]

## Reusable lessons

- 🔴 **Never trust a relayed classification without checking it against real data** — a claimed target brick
  id here did not exist in the master at all (only 11 of 12 direct-reallocation claims checked out); verify
  every relayed target id against the live master before applying.
- 🔴 **Address-text inference is a FIRST pass, not a substitute for the owner's ground-truth rep/territory
  knowledge when the two conflict** — surface the conflict with the concrete evidence, then defer to the
  owner; do not keep re-arguing past a clear, repeated correction (the owner overrode a customer-address read
  twice on B106-79 and was right). A nationwide pharmacy/brand name in an address (e.g. "كليوباترا") is a weak
  geography signal, not a locality tell.
- **Master-data deliverables:** match the app's real export look (`src/lib/sales/master-data/export-workbook.ts`
  — the Phoenix black/orange visual language), and never show only codes — always codes AND names paired
  ([[feedback-show-names-not-codes]]).
- 🔴 **After executing a production change that a deliverable file was built to PROPOSE, update the file's
  status before re-sharing it** — handing over a document that still reads as an open proposal after the fact
  confuses the owner (it read "why do these still show as uncovered?").
- **Having a fact recorded in memory is not the same as applying it** — cross-check every master-data
  deliverable against the FULL relevant memory context, not just the live conversation thread (a per-line
  region split already recorded in memory was missed on the first cut of the deliverable).
