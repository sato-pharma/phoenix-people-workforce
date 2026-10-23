---
name: the-january-parity-window-stays-refused
description: "The parity window 2026-01-31 → 2026-03-01 refuses forever at 338 rows and the owner ruled on 2026-10-23 to LEAVE IT — they are real visits by two resigned reps (Amany Wasiem B-111, Mostafa Mamdouh B-82) that iReports360 no longer serves; never delete them, never build an exemption, never re-raise it."
metadata:
  node_type: memory
  type: project
  originSessionId: 154ed2c1-c999-4e0b-8f74-060c2887ab9e
  modified: 2026-10-23T07:32:52.390Z
---

`ireports360_parity_windows` row `window_from = 2026-01-31` has stood at `status = refuse`,
`extra_in_mirror = 338` since 7 Oct 2026, and it will stay there. **This is settled — do not
re-open it.**

**What the 338 rows are.** Measured 23 Oct 2026 by fetching that window from iReports360 and
diffing it against `ireports360_visits`: exactly two agents, and their ENTIRE mirrored history —
`Amany.Wasiem ( Assuit 1 / F  )` (crm id 1413, 185 rows) and `Mostafa.Mamdouh ( Alex East  / P )`
(crm id 1466, 153 rows). Every one of the 338 was written in a single backfill at
**2026-09-13 00:37 UTC**, and the vendor returns none of them now. Both reps have since resigned —
B-111 on 2026-07-09, B-82 on 2026-08-31 — so the vendor appears to stop serving a departed
account's visits, while the mirror keeps what the backfill caught.

**The mirror is right and the vendor's answer is lossy.** Deleting them would erase 338 real
January–March field visits for two people. The `PARITY_MAX_DELETE_ROWS` guard is what stopped it.

**The owner's decision, 2026-10-23: "Leave it refused."** He was given three options — leave it,
exempt a departed rep's unserved visits so the window can verify again, or record a one-time
accepted baseline — and chose to leave it. The accepted cost is one vendor fetch and one
`crm_parity_sweep_refused` row whenever that window comes round (~every 10 days), **and that
Jan–Mar is never re-verified for any new drift.** Do not propose an exemption or a baseline again.

**How to apply:** seeing `crm_parity_sweep_refused` with 338 of 11,574 for `2026-01-31`, recognise
it and move on — it is not a new fault and not a regression of
[[the-error-table-never-says-which-needs-you-source-timed-out]]-style blindness. A refusal on the
NEWEST window with a different number is a different thing entirely: that was Phoenix-born visits
being counted as vendor losses, fixed in #6313 and accounted in
`docs/crm-parity-sweep-mirror-only.md`.

**Re-run 2026-10-23 12:12 Cairo, at his own request, and it refused again — identically.** CRM
11,236 vs mirror 11,574, extra 338, `repairedDeleted: 0`; `ireports360_sync_deletions` unchanged at
593 and the window still holds all 11,574 visits. The recorded reason is the ceiling: 338 is over
the 250-row `PARITY_MAX_DELETE_ROWS` limit, so the sweep leaves it for a human rather than deleting
settled rows unattended.

🔴 **The ceiling is the ONLY thing standing between those rows and deletion, so never run the live
sweep on this window without reproducing the comparison read-only first.** If the vendor's answer
ever shifts and the gap falls under 250 (or under the share ceiling), the sweep will DELETE them in
the same run that produces the number, with nothing to stop it. The read-only form is the same
vendor fetch plus `compareVisitIdSets` and `decideParityAction`, writing nothing. See
[[a-refused-parity-window-can-heal-itself]] for how to force one window.
