---
name: september-books-ownership-split-across-sessions
description: "Several live sessions wait on the same September upload — his 2026-10-09 instruction to have them talk directly — so ownership is split: the Office channel (read-time respread, upload-set notice, watching the five missing books) belongs to the sales-upload/closing-audit session and the September store-split rebuild to the CNS store-splitting session; nobody writes au.monthly_store_split_net and nobody publishes or unpublishes, and `.claude/rules/sales-closing.md` is the file four PRs collided on in one hour."
metadata:
  node_type: memory
  type: project
---

🔴 **HIS INSTRUCTION, 2026-10-09: "there are three sessions waiting for the Marcyl sheet … open a
conversation with each other to avoid conflict."** So a session that finds itself waiting on
September's books does not sit silent: it messages the other waiters with `SendMessage` (addresses
come from `ListAgents`) and says what it owns.

**The split agreed and sent that evening**

| Half | Owner |
| --- | --- |
| The Office channel — the read-time respread (#5676), the upload-set-complete notice (#5677 via roll-up #5683), and watching the five outstanding books so he is told the moment one lands | the **Sales upload / monthly closing audit** session |
| The September store-split rebuild — he unpublishes, then `backfill-attribution-store-split --apply 2026-09`, then `au.f_refresh_monthly_attribution('2026-09')`, then he re-publishes | the **Store splitting in monthly closing for CNS** session, which measured it (347 cells, 1,030,551.19 EGP, CNS 221,712.21) |

🔴 **Neither writes `au.monthly_store_split_net` directly, and NO session publishes, unpublishes or
re-dates a month** — that is his own click in the Monthly Closing screen, never chat
([[publishing-one-line-freezes-the-whole-periods-store-split-net]]).

🔴 **`.claude/rules/sales-closing.md` is the collision point: FOUR PRs touched it inside one hour**
(#5675, #5676, #5677, #5682 → roll-up #5683). Say so to the other sessions before opening a PR that
edits it.

**Why:** the same upload gates several sessions' work, and without a word between them two of them
rebuild the same period, or one moves a constant the owner has already ruled on.

**How to apply:** when a September book lands, the owner of that half acts and the other is told;
`select distributor_code, max(created_at at time zone 'Africa/Cairo') from
source_of_sales_import_batches where period = '2026-09' group by 1` is the trigger test, and
🔴 **"Marcyrl's Office book" IS ONE UPLOAD — `Office`, whose `distributor_name` is Marcyrl**
(the repo's own rule: `.claude/rules/sales-closing.md`, "Marcyrl IS the Office channel", owner
2026-10-05). **`MC` is mec — A SEPARATE DISTRIBUTOR, never one of Marcyrl's books** (owner,
2026-10-09: *"MEC is a separate distributor"*). An earlier version of this line read his words as
two uploads and sent a session hunting a second trigger; there is one trigger, the September
`Office` upload, and it is also the respread's only input
([[office-allocation-goes-stale-when-a-batch-is-remapped-after-it]],
[[the-office-code-is-marcyrl-and-mc-is-mec]]).

🔴 **A SOURCE CAN APPEAR AS WELL AS DISAPPEAR, so compare the two months BOTH WAYS** (the peer
session that verified the five absent books independently, same evening): `SF-T` is the mirror case
— one September batch and none in August — and `EP-BK` is in neither. A set difference in one
direction reads a brand-new source as noise, which is the defect #5671/#5674 just closed. Nine of
September's fourteen books landed between 16:17 and 16:51 Cairo on 2026-10-09, so the last five may
arrive the same night.

**Agreed between the two owners, 2026-10-09:** when September's `Office` batch exists, the Office
owner runs `node scripts/check-office-allocation-drift.ts 2026-09` — a READ, nothing that writes —
before anyone publishes CNS, and tells the rebuild owner. Today it answers `2026-09 → no Office
batch`. Its detector is the peer's #5679, and 🔴 **its 3,698 units / 3.37% and the loader's 6,834
packs / 6.23% are both true, measured at different points — neither is a correction of the other.**
Any such check reads the batch's **`created_at`**, never `updated_at`: a 2026-09-04 18:33 UTC
backfill rewrote every older `updated_at` and makes January–July read clean.
