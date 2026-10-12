---
name: september-2026s-office-spread-stays-as-it-is
description: "🔒 OWNER RULING 2026-10-09/10 — \"leave September's Office spread as it is\": the STORED Office allocation rows for 2026-09 are never rewritten, worth about 156 achievement points to Sohag 1. It does NOT freeze what managers see — `OFFICE_RESPREAD_START_PERIOD` is `2026-09`, so the closing engine re-spreads September at READ time on every load — which means the achievement is a LIVE number that moves with every mapping decision, not a figure that can be kept: Sohag 1's CNS read 175.8% at 22:17 Cairo and 173.4% at 01:15 after seven more customers moved to Sohag 2. His follow-up ruling, 2026-10-10: "record 173.4% and let it move as mapping decisions land" — the live figure is ACCEPTED as it stands and September is deliberately NOT pinned. Never offer a re-spread of the stored rows, and never offer to freeze or publish a month to hold a number."
metadata:
  node_type: feedback
  type: feedback
  originSessionId: 7d87f9ce-e2e0-4338-ba57-8b380f850d09
---

**His words, 2026-10-09 just before midnight Cairo:** *"leave September's Office spread as it is"* —
answering a `Next step:` line that offered the re-spread as his own click on the Monthly Closing
screen, never as a chat yes.

## What it settles, and what it does NOT

* **Settled:** the stored Office allocation rows for 2026-09 are not rewritten. Sohag 1's stored
  Office credit stays at 591,889.51 EGP / 6,840 units. Do not re-propose re-spreading them, not as
  a question, a `Next step:` line, a plan or a "while we are here".
* **NOT frozen — what a manager sees.** He moved `OFFICE_RESPREAD_START_PERIOD` to `2026-09`
  earlier the same day (*"make September's Office split recalculate like October"*, PR 5702), so the
  closing engine re-spreads September **at read time** on every load. The screen therefore already
  shows Sohag 1's September CNS Office credit as **355,409.55 EGP / 4,107 units** and achievement
  **175.8%**, against **245.9%** on the stored spread and **70.5%** on its own sales alone. The two
  rulings are consistent: recalculate on read, never rewrite the rows.
* So "leave the spread as is" has **no effect on any published or displayed figure** — it declines a
  write, not a behaviour. Say that plainly rather than reporting a frozen number.
* 🔴 **AND THE ACHIEVEMENT CANNOT BE "KEPT" AT A VALUE AT ALL WHILE THE MONTH IS UNPUBLISHED.** He
  answered a quoted *"keep Sohag 1's September CNS at 175.8%"* on 2026-10-10, and re-measuring on the
  same code path returned **173.4%** — own sales 234,689.69, Office credit 350,685.17 / 4,053 units,
  respread −241,204.34. Nothing was changed to cause it: **seven more customers moved from Sohag 1 to
  Sohag 2** between the two readings (680 rows / 844,345.61 against 687 / 847,786.09; Sohag 2 435 /
  270,995.47 against 428 / 267,555.00), worth exactly the 3,440.47 EGP the own-sales line lost, as
  other sessions applied mapping decisions. The national respread grew with it, 938,242.26 →
  942,966.65. **So quote a read-time achievement WITH its Cairo timestamp, and never offer to hold one
  at a value** — only publishing the month fixes a figure, and that is his click on the screen.

## His second ruling — the live figure is accepted, not pinned

**His words, 2026-10-10 about 01:20 Cairo:** *"record 173.4% and let it move as mapping decisions
land."* Said after being shown that the achievement he had just been asked to confirm at 175.8% had
already become 173.4% with nothing changed.

* **Sohag 1, CNS 2026-09, as at 01:15 Cairo on 2026-10-10:** own sales **234,689.69 EGP**, Office
  credit as read **350,685.17 / 4,053 units** against **591,889.51 / 6,840** stored, respread
  **−241,204.34 EGP / −2,788 units**, target 337,595.66, **achievement 173.4%** — 244.8% on the
  stored spread, 69.5% on its own sales alone. National CNS 11,885,444.55; the respread moves
  942,966.65 EGP across 48 areas, net 0.00.
* **He chose drift over pinning.** So do not propose publishing, snapshotting or freezing September
  to stabilise a number, and do not treat a later, different reading as a regression — it is the
  system working as he ruled. Report the figure with its Cairo timestamp and move on.
* 🔴 **Asking him to confirm a read-time figure was the error, not the drift.** A number that is
  recomputed on every load is not something he can approve; what he can rule on is the BEHAVIOUR.
  Put the behaviour in the box, never the value.

## What the respread does to people — the three biggest movers, measured

Measured 2026-10-10 01:15-01:32 Cairo through the live engine (`00e2cdbc0`, `cadb66cae`). Stored
achievement → live achievement, with each area's own-sales-only achievement beside it:

| Area | Rep (seat held) | Own sales alone | Stored | **Live** | Move |
| --- | --- | --- | --- | --- | --- |
| Cairo East 1 | Ali Mohamed Shehata Hassan, active since 2026-02-07 | **92.4%** | 123.9% | **223.8%** | **+100** |
| Sohag 1 | (area, Upper Egypt) | 69.5% | 244.8% | **173.4%** | −71 |
| Down town | Adel Eid Abdelrahman Mohamed Srour, 2026-08-02 → 2026-10-04, resigned | **19.4%** | 140.6% | **45.6%** | −95 |

**The pattern, and why it is the rule working:** the respread moves Office credit toward the rep
whose OWN book earned it and away from the one whose did not. Ali earns 92.4% on his own feet and
ends at 223.8%; Adel earned 19.4% and ends at 45.6%. District managers: Mina Farouk Nawar Rizkallah
(Cairo, `SEAT-CNS-DM-CA`) gains, Sameh Shabaan El Hoseiny El Hoseiny (Giza, `SEAT-CNS-DM-GZ`) loses.
National: 942,966.65 EGP moves across 48 areas, net 0.00.

**So a big swing is never on its own evidence of a defect** — check the area's own-sales-only
achievement first. A large fall with a weak own book is the rule correcting an artefact; a large rise
with a strong own book is the rule paying the right person.

## Why the write was offered at all, and why it stays declined

Re-spreading an unpublished month restates **every** achievement in it, not just the area that
raised the question — the respread conserves (938,242.26 EGP moved across 48 areas, net 0.00) but
individual areas move hard: Down town −482,704.23, Cairo East 1 +418,126.96, Sohag 1 −236,479.96,
Sohag 2 +220,361.45. That is a people decision on a screen with his eyes on it, which is exactly why
it was never put as quoted words in a box. Related:
[[sos-monthly-closing-is-the-only-sales-truth]], [[never-fix-a-published-and-announced-month]],
[[a-customer-map-re-resolve-stales-a-pre-october-office-spread]],
[[the-sohag-brick-structure-is-correct-as-it-stands]].

## The recorded reading — 173.4%, confirmed again on 2026-10-12

**His instruction, 2026-10-12 15:08 Cairo:** *"record 173.4% for Sohag 1 and let it move"* — the
same ruling as 2026-10-10, restated, so the figure below is the RECORD and the movement is expected.

Measured the same minute through `scripts/restate-area-month.ts --area="Sohag 1" --line=CNS
--period=2026-09`, in a tree whose `src/lib/sales`, `src/lib/closing` and `src/config` are
byte-identical to `origin/main` (checked before the run, because the engine code IS an input):

| | 2026-10-10 01:15 | 2026-10-12 15:08 |
| --- | ---: | ---: |
| own sales (everything but Office) | 234,689.69 | 234,689.69 |
| Office credit as the closing READS it | 350,685.17 / 4,053 u | **350,685.17 / 4,053 u** |
| Office credit as the rows are STORED | 591,889.51 / 6,840 u | 597,636.28 / 6,907 u |
| what the respread moves | −241,204.34 | −246,951.11 |
| target | — | 337,595.66 |
| **achievement** | **173.4%** | **173.4%** |
| achievement on the stored spread | 245.9% | 246.5% |
| achievement on its own sales alone | — | 69.5% |

🔴 **The STORED Office book grew (more September rows landed) and the read-time credit did not move
at all** — which is the respread doing its job: the credit Sohag 1 keeps is set by its share of the
line's non-Office VALUE, not by how many Office rows were stamped on it. So a growing stored book
moves the *stored* figure (245.9% → 246.5%) and leaves the real one alone.

Conservation re-checked at the same reading: 374,206.12 EGP leaves and 374,206.12 EGP arrives across
**48** areas, **net 0.00**, on national CNS September sales of 11,885,444.55 (Sohag 1 is 4.93% of
it). The largest movers are still Sohag1 −246,951.11 and Sohag2 +232,440.80.

September is still **unpublished** — every `monthly_closing_publications` row carries an
`unpublished_at` — so nothing pins this figure and nothing may be offered to pin it.
