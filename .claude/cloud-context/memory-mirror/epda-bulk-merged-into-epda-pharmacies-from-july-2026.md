---
name: epda-bulk-merged-into-epda-pharmacies-from-july-2026
description: EPDA sent one merged قطاع الصيدليات file for July and August 2026, so EPDA-BULK's absence those two months is CORRECT — the coverage banner's 24.16M EGP "hole" is FIXED (#5671, #5674), and the bulk book uploads on its own again from the September closing.
metadata:
  type: project
---

EPDA-BULK (`EP-BK`, ساتو قطاع الجملة) has four batches ever — 2026-02, 03, 04 and 06, all uploaded
by B-10 on 28–30 July 2026 in the history backfill: 409 rows, 92,197 packs, 19,328,611.50 EGP, every
row valid and brick-resolved.

**Proof of the merge** (production, 2026-10-09): EPDA-Pharmacies' Head Office Lacto Basic went
4,726 packs in June → **38,910 in July** → 56,588 in August, while the bulk book stopped. June's two
books together were 42,839 against July's single 38,910. **Its only real holes are January and
May** — plus September, which is a genuine outstanding file, because by his 2026-10-09 ruling the
sector uploads on its own again from the September closing and
[[epda-bulk-is-allocated-like-office-on-pedia-from-september-2026]] has nothing to spread without it.

The book is 99.2% Head Office Lacto Basic (LA003/LA004 — an untracked line AND confidential codes
stripped by both closing RPCs); only 599 packs / 161,730 EGP of Lacto Advanced ever reached a
closing, and none of its four months is published.

🔴 **FIXED — do not re-report this as a live defect.** The SoS coverage banner priced the five absent
months at **24,160,764 EGP**, the largest hole on the board, printed the raw code, and read "DIRECT is
missing from 2026-09" about a channel that landed 880,976.70 EGP as DirectReq. `sos-coverage.ts` now
declares **three** absences that are not holes — the Direct fold, `MERGED_SOURCE_WINDOWS`
(`EP-BK → EP-PHS`, 2026-07..2026-08 only, #5671) and `SOURCE_ONBOARDINGS` (`QM` from 2026-08, #5674,
El Qema's own 10,541,399 EGP phantom) — and names the distributor. Measured over the 150 validated
batches: headline **24,160,764 → 14,496,459 EGP** (January, May, September), trailing count 11 → 10
other distributors. The rule and its account live in the repo now
(`.claude/rules/sales-imports.md`, `docs/agents-owner-rules.md`), so never re-add it here.
