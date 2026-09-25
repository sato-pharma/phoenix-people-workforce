---
name: never-silent-drop-count-and-flag-instead
description: "OWNER RULE 2026-08-10 — the system must never delete a sales row on its own; count it, flag it, and let him decide. Also: a rollup refresh on a batch that mixes a LOCKED line silently does nothing."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: cfb1b008-82c7-4a44-b3f1-382f5e0f94a9
  modified: 2026-08-10T20:20:01.384Z
---

His words, 2026-08-10, when told Phoenix drops a duplicated UPA tender line:

> **"count don't drop, flag for me and leave decide, but never silent drop."**

**Why:** an `IGNORE` alias is the only mapping that DELETES rows
([[ignore-alias-deletes-and-the-manual-closing-decides]]). When it hides a real Phoenix product the
loss is invisible — no row, no count, no warning — and the closing is quietly short. He would rather
carry a suspicious number he can see than a clean number that hides a decision the system made for
him. This overrides the instinct to "fix" a double count by suppressing one side.

**How to apply:** never resolve a data-quality doubt by dropping rows. Import them, mark them, and
surface the flag. Applied to the Dopaminict case: the `PS` alias
`دوبامينكت 1مجم 20قرص هـ ش 28` was re-pointed from `IGNORE` to `DO001`, and July's six deleted rows
(212 units) were reinstated carrying
`raw_row->>'source' = 'reinstated-from-ignore'` and a `flag` of *"SUSPECTED DUPLICATE of the same
PS-T tender line"* — see [[ps-and-ps-t-carry-the-same-upa-tender-line-twice]] for the evidence that
they ARE duplicates. Counted and visible, decision left to him.

Audited the same day: **64 IGNORE aliases across 8 distributors, all active. 63 are genuinely
not-Phoenix products** (Anoxicam, Trencedia, Vonopep, Fortrostep, Rispadex 2mg — other
manufacturers' items arriving in distributor files). The Dopaminict one was the only alias
suppressing a real product. Re-run that check — IGNORE alias whose alias text maps to a real
product under a DIFFERENT distributor — before trusting any closing.

## The trap this exposed

**`phx_refresh_sos_fact_rollup(batch)` operates on the WHOLE batch, so a batch that mixes a locked
line with an open one cannot be refreshed at all — and it fails SILENTLY when wrapped in the usual
exception handler.** The July `PS` batch `a4263715-708b-4d64-bf3c-74cccc9eb3fd` carries CNS **plus**
Head Office, Pedia and Anti Infective; Pedia and Anti Infective July are locked, so the CNS side sat
at 1,738 in `fact_rollup` while `import_rows` said 1,950 and the closing showed the stale figure.

**Always verify the rollup after writing, per batch** — `import_rows` vs `fact_rollup` for the
period+line, and check the `drift` column is 0 on every batch. Every other July batch was clean; only
this one drifted, and only by the amount just written. The fix was a direct CNS-only insert into
`source_of_sales_fact_rollup` (the lock trigger allows it because CNS July is open), never unlocking
the other lines — see [[pedia-and-anti-infective-july-are-correct-do-not-restamp]].
