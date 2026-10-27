---
name: cns-identity
description: "The CNS line has its own event and product identity — the repo skill `.claude/skills/cns-identity/`, Tebofortin the hero, forest-green field with a connectome and a ginkgo; four named differences from the Anti-Infective skill, and a closing sheet whose three hardest laws are business rules."
metadata:
  node_type: memory
  type: project
  originSessionId: 04e07ced-67f8-499c-9d53-ba368c0b9505
  modified: 2026-10-13T12:04:50.965Z
---

The CNS line's identity is a **repo skill**, not a folder of images: `.claude/skills/cns-identity/`,
built 13 October 2026 on `codex/cns-identity` (PR
[#5872](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/5872), unmerged when this was
written). Claude Code loads it by itself when a CNS piece is asked for — there is nothing to
remember beyond that it exists and what it refuses to do.

**Tebofortin is the hero** (Ginkgo biloba leaves extract — 40 / Forte 80 / Intens 120 / Max 240 mg
and the 40 mg/ml oral drops), Conviban beside it. It ships four pieces: the name card and the
invitation card (1200×1580), the A4 line sheet, and the **monthly closing sheet**.

It shares the house skeleton with `anti-infective-identity` — field → seam → white foot → base bar —
and differs in exactly four named ways, so the two stack as one company. It does **not** replace
`sato-pharma-identity`, which still governs certificates, documents, the business card and the site.

**The closing sheet's three hardest laws are business rules, not design ones**, and they are the
part worth recalling before anyone edits it:

- it **reports, never computes** — both the sales and the target are read from the published
  Monthly Closing for the month on the sheet ([[sos-monthly-closing-is-the-only-sales-truth]]);
- the **units column is never totalled** ([[units-of-different-products-are-never-added]]) — the
  total row's units cell is an em dash deliberately, and `verify.py --closing` measures the ink in
  that cell so a later edit cannot quietly complete it;
- the **foot obeys the house ink rule** even though the green field does not: a data table a manager
  reads is a document, so the 6% zebra is the only filled area in it.

**Why:** the look of a CNS piece is now settled and mechanically checked, so the next request for one
is a render, not a design conversation — and the closing sheet carries two locked sales rules inside
a design file, where a designer would not expect to find them.

**How to apply:** for any Tebofortin, Conviban or CNS event piece, render from
`.claude/skills/cns-identity/reference/` and measure the result with `reference/verify.py`
(`--card`, `--sheet`, `--closing`) — never judge it from the CSS. Rispadex, Dopaminect and
Dolabactin have no pack art in the skill yet, and no CNS portrait set has been graded, so the
invitation card's shadow constant is still unproven.
