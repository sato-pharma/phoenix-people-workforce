---
name: reallocation-668-bricks-full-plan-live
description: "The full 674->668 brick / 142->168 block reallocation plan (Locked_Area_Brick_Block_Reallocation.xlsx) is LIVE in production as of 2026-07-24. See [[reallocation-14-uncovered-bricks]] for the earlier, smaller sub-fix this built on."
metadata: 
  node_type: memory
  type: project
  originSessionId: 13d2cbc9-99e8-4d8f-b6cc-e899420ca975
  modified: 2026-07-24T03:17:17.283Z
---

**2026-07-24 — the full reallocation plan is applied to production.** Owner asked to implement the
whole plan ("PROCEED IMPLEMENTING TO THE SYSTEM" -> confirmed scope = "خطة الـ668/168 الكاملة" via
AskUserQuestion), not just the 14-uncovered-bricks sub-fix from earlier the same day.

**What the plan actually contained (verified precisely, not estimated):** the `Brick Comparison` sheet
in the owner's original file has 674 rows, one per old brick: 550 `Keep` (no action, matches the
already-verified 668-master exactly), 108 `Split / Reallocate`, 9 `Rename Only`, 6 `Merge Duplicate`,
1 `Move / Correct` — 668 end Active + 6 end Inactive-Merged = 674, reconciles exactly. `Block Comparison`
has 142 rows: 117 `Keep`, 17 `Split/Rebalance`, 6 `Clean-up/Rebalance`, 2 `Retire/Move All` (B111, B118).
My own earlier "~424 bricks / ~139 blocks" estimate (given verbally to the owner before this check) was
wrong — the real remaining scope was ~124 bricks / ~25 blocks, an order of magnitude smaller. **Lesson:
never repeat a rough guess as if it were verified — the owner correctly got confused by the gap between
"~424" and the eventual real numbers; should have said "rough estimate, will verify" up front.**

**Fidelity check (the owner explicitly asked for this — "ANA 3AYZ NOSKHA TBK ELASL"):** compared my
working `Phoenix_Customer_Remap_VERIFIED.xlsx` ("New Brick Master (668)" / "New Block Master (168)",
built earlier this session from the JSONL decision log) against the ORIGINAL file's own
`Recommended Brick Master` / `Recommended Blocks` sheets — 100% match, 0 mismatches in ID sets AND in
every name/block/area field. No drift had crept in.

**Two real bugs caught by verification before executing (both would have silently broken things):**
1. **27 of the 124 "old" bricks in the plan don't exist live at all** (not even inactive — absent from
   `source_of_sales_bricks` entirely) and have zero `customer_map` rows — e.g. `B105-99/100/101`,
   `B53-91` through `B53-97`. These are phantoms from the plan's own source inventory, not a mistake to
   chase — confirmed harmless, just skipped (no deactivation attempted, nothing to deactivate).
   `B105-101` specifically is the SAME "old brick" the relayed 14-uncovered-bricks classification had
   confused with the live-only `B110-63` earlier the same day — both are real "سابا باشا" bricks from
   different sources, both correctly converge on `B149-16`.
2. **7 of the 9 "Rename Only" rows have Old Brick ID == New Brick ID** (obvious in hindsight - a rename
   keeps its own id) and were briefly in my generated "deactivate" list before I checked — deactivating
   them would have killed a brick that's ALSO its own correct target, silently erasing a live territory.
   Caught by explicitly comparing Old vs New Brick ID for every Rename-Only row before running the
   UPDATE. Fixed: those 7 (`B107-19, B108-10, B11-10, B121-5, B2-30, B3-5, B83-37`) stay active; 4 of
   them got a real name UPDATE (`B108-10`->"رشدي - الإسكندرية", `B121-5`->"الإسماعيلية", `B2-30`->"روكسي",
   `B3-5`->"ميدان الإسماعيلية"), the other 3 needed no change (name was already identical).

**Owner pushed for "DROP ALL BLOCKS AND BRICKS AND RE BUILD" at one point** - talked through why that's
strictly worse than the additive approach (550 Keep bricks + 117 Keep blocks are already exactly
correct; dropping them risks breaking something that works for zero benefit, plus a window where the
tables are empty/inconsistent) and got agreement to proceed with the safe incremental version instead,
same end state either way. **Lesson: when a destructive instruction is objectively unnecessary given
information the owner may not have had in view (here: the Keep-row counts), explain the concrete
technical reason and propose the equivalent-outcome safe alternative rather than just complying or just
refusing.**

**Execution (all via `execute_sql` against production `ozucdzovmcqvepbozvqf`, schema-checked first):**
- 25 new blocks created (`B150-155, B158-176`), matching `source_file = 'manual:668-brick-reallocation-2026-07-24'` convention.
- 107 new bricks created (3 batches to keep each SQL call reasonable).
- 90 old bricks deactivated (97 minus the 7 rename-only saves above).
- 4 in-place renames applied.
- 4 audit_logs rows written (blocks created, bricks created, bricks deactivated, bricks renamed) since raw SQL bypasses the app's `writeAuditLog` call sites.
- **Final live counts, verified: 458 active bricks (441+107-90), 176 active blocks (151+25) — both exact matches to the computed plan, no surprises.**

**What's still NOT done (explicitly deferred, matches the owner's "neglect customers now" instruction
from earlier the same day):** `source_of_sales_customer_map` (49,712 rows) has NOT been touched for
either the 14-fix or this main-plan batch. Every customer still pointing at any of the 104
now-deactivated old brick ids (14 + 90) will silently stop resolving on the next monthly import (the
importer only loads active bricks) until the customer remap happens. The B25-43 split proposal
(`scratchpad/b25_43_split_proposal.csv`, may need rebuilding if scratchpad was cleared again) and the
full old-brick-id -> new-brick-id crosswalk for this larger batch (`scratchpad/full_brick_crosswalk_non_keep.csv`)
are the starting points for that next phase whenever the owner says go.

**Process note:** this session's scratchpad got silently cleared TWICE today mid-work — re-derive
region/area reference data from live Supabase (fast, authoritative) rather than assuming a cached CSV
extract is still there; don't waste time trying to recover it.

**2026-07-24 — owner demanded exact confirmation, found a real second gap.** After the batch above,
owner said "IMPLEMENT A PLAN TO COMPLETE THE MASTER DATA BASE TO CONFIRM 168 BLOCKS AND 668 BRICKS
MUST BE FINISHED AND CONFIRMED FIRST" (plan mode). Read-only check found live was 458/176, not
668/168. Root cause: the earlier batch only processed the plan's 124 non-Keep rows; it never checked
whether the 550 `Keep` bricks (and the block-level `Keep`/unlisted equivalents) were ACTUALLY live —
`Keep` describes the recommended action, not brick existence. Found: **210 target bricks were phantom
(Keep-labeled but never created)**, and **8 blocks were live-but-not-in-target** (`B111`/`B118` — the
known Retire/Move All blocks whose bricks were deactivated earlier but whose block row was never
flipped — plus `B103/B112/B113/B115/B116/B71`, absent from the plan's 142-row Block Comparison sheet
entirely, a block-level echo of the same "uncovered" pattern). Confirmed all 8 blocks had zero active
bricks before retiring (safe, no relocation needed). Created the 210 bricks (6 SQL batches, same
`manual:668-completion-2026-07-24` convention), retired the 8 blocks, wrote 2 more audit_logs rows.
**Final state independently verified as an EXACT set match, not just counts**: pulled the full live
brick_id/block_code sets fresh and diffed against the verified target master — 0 missing, 0 extra, on
both bricks and blocks. `source_of_sales_bricks`/`source_of_sales_blocks` are now a confirmed, exact
668/168 match to `Locked_Area_Brick_Block_Reallocation.xlsx`. **Lesson: "Keep" (or "no action needed")
in a migration plan is a claim about the RECOMMENDED ACTION, never proof the referenced row already
exists — always verify existence independently, the same discipline already applied to the "action"
rows, applied symmetrically to the "no action" rows too.**
