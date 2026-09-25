---
name: ps-and-ps-t-carry-the-same-upa-tender-line-twice
description: "Overseas ships the same UPA tender line in BOTH the PS and PS-T files — the PS copy is IGNORE-mapped on purpose, and the owner's manual closing double-counts it"
metadata: 
  node_type: memory
  type: project
  originSessionId: cfb1b008-82c7-4a44-b3f1-382f5e0f94a9
  modified: 2026-08-12T12:52:55.551Z
---

Overseas (`PS`) and Overseas Tender (`PS-T`) both carry the item text
**`دوبامينكت 1مجم 20قرص هـ ش 28`** (هـ ش = هيئة الشراء الموحد, the unified-purchasing channel). It is
**one sale reported in two files**, so the aliases are deliberately asymmetric:

| distributor | alias | maps to |
| --- | --- | --- |
| `PS-T` | `دوبامينكت 1مجم 20قرص هـ ش 28` | `DO001` Dopaminict 1mg UPA |
| `PS` | same text | **`IGNORE`** (set 2026-08-09) |

**The IGNORE mapping is correct — do not "fix" it.** It looks like a bug (it is the only mapping that
DELETES rows, see [[ignore-alias-deletes-and-the-manual-closing-decides]]) and it makes Phoenix
*lower* than the manual, which reads like Phoenix losing sales. It is not.

Proved on CNS July 2026: his manual has DO001 at **1,950** against Phoenix's **1,738**, and every one
of the six differing customers is an exact duplicate pair —
`3002391` 45+45, `3001944` 30+30, `3000171` 23+23, `3000187` 16+16, `3000048` 14+14, and `3000150`
236+177+84+**84**. **Phoenix is right; the manual double-counts 212 units.** Note `3002391` books its
two copies in *different areas* (Port Said and Cairo East 1), so a per-area check hides it — only a
per-customer check finds it.

**Why:** this is the mirror image of the Rispadex UPA fix from the same day
([[owner-office-allocation-rule-value-share]] session), where re-pointing the EG-HOS/SF-T aliases to
`RI001` was the right call. Same channel, opposite remedy — so never generalise "UPA product is
short ⇒ re-point the alias". Check whether the two files overlap first.

**How to apply:** before changing any UPA/tender alias, list the customers on both sides and look for
exact duplicate quantities. If they double, the IGNORE is doing its job.

These are real duplicates, but under [[never-silent-drop-count-and-flag-instead]] they are now
**counted and flagged**, never dropped silently — the owner decides what a flagged row does.
