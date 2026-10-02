---
name: reallocation-14-uncovered-bricks
description: "The 14 live bricks the 668-brick reallocation plan didn't cover are RESOLVED and APPLIED to production 2026-07-24 (3 blocks + 16 bricks inserted, 14 deactivated) — do not re-audit them as open. The FULL 668/168 plan went LIVE the same day and stale customer_map rows were repointed (7,824 of 7,832; 8 B25-43 outliers left for the owner). Holds the per-LINE region data fact and the relayed-classification / owner-ground-truth lessons."
metadata: 
  node_type: memory
  type: project
  originSessionId: 13d2cbc9-99e8-4d8f-b6cc-e899420ca975
  modified: 2026-10-02T16:38:37.254Z
---

The 14 live production bricks that the 674→668 reallocation plan (`Locked_Area_Brick_Block_Reallocation.xlsx`)
did not address were **RESOLVED and APPLIED to production 2026-07-24** — do NOT re-audit them as open. All 14
fold into the live 668-brick set: 3 new blocks (B149/B156/B157) + 16 new bricks inserted, the 14 old bricks
deactivated (`active=false`), tagged `source_file = 'manual:14-uncovered-bricks-resolution-2026-07-24'` with
3 `audit_logs` rows (raw `execute_sql` bypasses the app's own `writeAuditLog`). 12 were direct
reallocations, B106-79 merged into B5-64 (Heliopolis — owner override), B25-43 (a legacy catch-all) split by
address across Badr/Sadat/Kom Hamada/Buraijat.

**The customer remap is DONE too: `source_of_sales_customer_map` was repointed the same day** (owner's
go-ahead, 2026-07-24): 102 old→new brick_id pairs fixed 7,745 rows, and B25-43's split was re-classified
from the live rows (brick + area + region together) — **7,824 of 7,832 stale rows fixed; exactly 8 remain on
`B25-43`/`CA5`/`CA` as genuine outliers for the owner's territory knowledge** (3 share the village "قرية
النجاح") ([[post-reallocation-stale-brick-audit]]). At the time of the 14-brick fix only the brick/block
structure was applied and customers on the 14 old ids would have stopped resolving in the next monthly
import; that is no longer open. (The B25-43 split proposal lived in a scratchpad CSV that may be gone;
scratchpad contents are not durable within a long session — [[localappdata-temp-is-live-tool-state]].)
**Superseded 2026-10-02:** previously "the one live open item: customer_map is STALE for those 14 old ids, deferred until the owner says go" — the same-day repoint recorded in [[post-reallocation-stale-brick-audit]].

**The wider 668/168-brick reallocation plan is LIVE in production too, applied later on 2026-07-24** (the
owner confirmed the full scope), and the live master was verified as an EXACT set match to
`Locked_Area_Brick_Block_Reallocation.xlsx` — 668 active bricks / 168 active blocks, 0 missing, 0 extra
([[reallocation-668-bricks-full-plan-live]]). Before that batch the live counts were ~441 bricks / ~151
blocks; never quote those as current. (The live block count was already higher than the plan's "142→168"
headline assumed, so prior legitimate manual block edits exist; verify block counts against live, never
against the plan's headline.)
**Superseded 2026-10-02:** previously "the wider 668/168 plan is still PAUSED and NOT applied; live counts ~441 bricks / ~151 blocks" — the full plan's same-day application recorded in [[reallocation-668-bricks-full-plan-live]].

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
