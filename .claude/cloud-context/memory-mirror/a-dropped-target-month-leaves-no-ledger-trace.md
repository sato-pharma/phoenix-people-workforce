---
name: a-dropped-target-month-leaves-no-ledger-trace
description: "A whole month of targets can vanish with nothing in au.monthly_targets_dropped or sales_audit_logs — look for an au.monthly_targets_<line>_<month>_backup_<date> table, which is the only surviving copy."
metadata:
  node_type: memory
  type: project
  originSessionId: 3dfa5eb2-1cfe-4ea8-b767-855d5e601f89
  modified: 2026-10-12T14:53:41.427Z
---

Pedia October 2026 held **zero** target rows on 12 Oct 2026 — every area, not only the Qena 2 gap he
asked about; Anti Infective October was entirely absent too, and only CNS had October (525 rows,
12,536,082.22, uploaded 7 Oct, the exact same value as its September). The 144 Pedia October rows
(36 areas × 4 products, 5,277,761.03) had been uploaded 1 Oct 14:53–14:56 and were gone by 2 Oct.

**Nothing recorded the removal.** No row in `au.monthly_targets_dropped`, nothing in
`public.sales_audit_logs`, nothing in git, nothing in memory — even though the same ledger *does*
hold his own drops of CNS October and of Pedia + Anti Infective September on 4 Oct 15:27–15:29. So a
missing month is never evidence of nothing having happened, and "why" may simply be unanswerable.

**The only surviving copy was `au.monthly_targets_pedia_oct2026_backup_20261002`** — the naming shape
`au.monthly_targets_<line>_<mon><year>_backup_<yyyymmdd>`. Search `information_schema.tables` in `au`
for `monthly_targets%backup%` before telling him a month's figures are lost. Row values there are
rounded per row, so a sum of `round(target_value,2)` comes to 5,277,761.11 against the raw
5,277,761.03 — quote whichever matches the artifact you are handing him.

**A second, separate cause of a one-area hole: the upload template only offers areas whose seat was
filled when he downloaded it.** `parseTargetsWorkbook` maps by header name, and the template lists
only areas with `carries_target = true` in `au_v_line_area_map`. Pedia Qena 2 (UE8) was missing from
the 4 Oct September upload because `SEAT-PED-REP-UE8` was first filled by Mostafa Ahmed Mahmoud
Mohamed effective 5 Oct — the day *after* the upload. His ruling, 12 Oct: **September Pedia Qena 2
needs no target at all** (nobody worked the month), and **October gets a fresh number he sets**, not
a split of Qena 1's 168,871.03.

Beni Suef (UE9) looks like the same kind of hole and is not: `foldAreaOptionsForLine` merges GZ6+UE9
into one Pedia area and the target belongs on GZ6, so a target typed on UE9 can never be shown or
edited. See [[a-third-of-target-carrying-territories-have-no-rep]],
[[qena-2-carries-no-cns-target-at-all]], [[the-qena-brick-move-reaches-every-month-and-jan-feb-hold-orphan-targets]].
