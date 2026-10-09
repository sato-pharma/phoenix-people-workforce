---
name: publishing-one-line-freezes-the-whole-periods-store-split-net
description: "isFrozenStoreSplitPeriod matches monthly_closing_publications by PERIOD with no line filter, so publishing one line freezes every line's store-split net for that month — deliberate, and it means a month still receiving uploads silently drifts away from today's rules in a way the units-based drift check cannot see — 2026-09 reached 1,030,551.19 EGP on different areas, CNS 221,712.21 of it, and his 2026-10-09 instruction — "rebuild the September store split when Marcyrl's Office book lands" — authorises the rebuild on an upload, not a date: the shipped notice reports five still missing — epda, EPDA-BULK, EPDA-Pharmacies, Marcyrl (`Office`, which IS Marcyrl, one book) and mec, so it reports to him for the unpublish when one lands."
metadata:
  node_type: memory
  type: project
  originSessionId: d5764c39-c02c-4dd4-a40d-70ad08cc490c
  modified: 2026-10-09T14:13:30.854Z
---

Only **Anti Infective 2026-09** is published (by him, 2026-10-05 16:25 Cairo, never unpublished).
That single publication freezes `au.monthly_store_split_net` and the attribution rollup for **the
whole of 2026-09** — `isFrozenStoreSplitPeriod` queries `monthly_closing_publications` by `period`
with no line predicate, matching migration `20260927213000`. **This is deliberate** (PR 4848's own
comment) — do NOT "fix" it to a per-line freeze; that is exactly what 4848 closed.

🔴 **HIS INSTRUCTION, 2026-10-09, in his own words: "rebuild the September store split when
Marcyrl's Office book lands."** (Earlier the same evening: "rebuild September's split once the last
books are in, not now.") So the rebuild is AUTHORISED and PARKED on an upload, not a date — and the
go-ahead is already given, so when the book lands it is reported to him for the unpublish, never
re-asked as a decision.

🔴 **"Marcyrl's Office book" IS ONE BOOK — `Office` IS Marcyrl.** Every `Office` batch ever
uploaded (2026-01..2026-08, `office N.xlsx`) carries `distributor_name = Marcyrl`, and the repo
already says so in `.claude/rules/sales-closing.md` ("Marcyrl IS the Office channel", owner
2026-10-05). `MC` is a DIFFERENT distributor — its name is **mec**. An earlier version of this note
read his words as two books and sent a session looking for a second trigger; there is one trigger,
the September `Office` upload, and it is also the respread's only input.

**What September still owes, from the shipped notice rather than a hand-rolled comparison**
(`node scripts/check-sos-month-complete.ts 2026-09`, run 2026-10-09 against production):
`INCOMPLETE 2026-09 missing=5` — **epda (`EP`), EPDA-BULK (`EP-BK`), EPDA-Pharmacies (`EP-PHS`),
Marcyrl (`Office`), mec (`MC`)**. 🔴 **A raw two-month comparison gets this wrong twice**: it adds
`DIRECT`, whose absence is CORRECT because DirectReq carries the fold, and it MISSES `EP-BK`, which
is absent from August too — the notice expects it because another source's file carried it for
2026-07..2026-08 only. 🔴 **And `EP-BK` has NOT "never arrived"** — it has four batches, 2026-02,
03, 04 and 06 (ساتو قطاع الجملة), and from July its volume appears inside `EP-PHS`, whose book went
0.998M EGP in June to 8.16M in July and 12.02M in August. Quote those books by VALUE, never by
summed units across product codes.
`node scripts/check-sos-month-complete.ts <period>` is the whole test.

**Measured 2026-10-09, twice, and the second number is the one to quote.** At 09:00 Cairo
`scripts/check-store-split-drift.ts 2026-09` reported 112 cells over 56 line×area pairs and
839,283.83 EGP on a different area; after thirteen more September books landed the same evening it
reported **347 cells over 76 pairs, frozen 139 cells against live 423, and 1,030,551.19 EGP on a
different area** — the drift GROWS with every upload, so a measurement is good only for the hour it
was taken. Sum of differences 0.00 — a pure redistribution. Pedia holds 40 pairs, **CNS 36 and
221,712.21 EGP of it**, and **Anti Infective — the one published line — holds 0**, so nothing he has
announced has moved. Largest CNS moves that evening: Sharkia 1 −37,234.56 → Sharkia 2 +37,234.56,
Alex West −36,759.14, Dakahlia 1 −32,160.69, Cairo East 2 +26,495.22, Sohag1 −26,155.39 → Sohag2
+26,155.39; the single biggest anywhere is Pedia Qalubeya −624,623.51.
Net last computed 2026-10-04 16:52 Cairo — **before thirteen of September's fourteen validated books
existed** ([[a-closing-rule-that-moves-zero-may-simply-have-no-upload-yet]]), which is the whole
cause here rather than a re-map ([[office-allocation-goes-stale-when-a-batch-is-remapped-after-it]]).

🔴 **Every line's total net UNITS agree, so the units-based publication drift check is structurally
blind to all of it** — the money moves between areas while the line totals match. Only
`check-store-split-drift.ts` sees it.

**Why:** a newly shipped read-time net rule looks like it does nothing on a frozen month, and a
month that is still being uploaded keeps drifting further from the frozen split with every file.

**How to apply:** check the period's publications before concluding anything about its area split.
Rebuilding a frozen net restates an announced number, so it is **his** decision at the Monthly
Closing publication screen, never in chat: unpublish the period → `scripts/backfill-attribution-store-split.ts
--apply <period>` → `select au.f_refresh_monthly_attribution('<period>')` → re-publish. With
September still mid-upload there is nothing to gain from rebuilding yet, and Anti Infective's own
numbers would not move if it were — which is exactly the call he made on 2026-10-09. **Never put the
unpublish itself in a `Next step:` box**: it is his own click in a screen Claude cannot reach, so it
belongs in the body with the path, and the box carries the decision he answers in words
([[never-put-his-physical-actions-in-the-next-step-box]]).
