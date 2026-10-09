---
name: office-allocation-goes-stale-when-a-batch-is-remapped-after-it
description: "Office units were allocated at UPLOAD time, so re-mapping any CNS batch afterwards left the spread on a base that no longer exists — 6,834 of August 2026's 109,719 CNS Office packs (6.23%, 548,777 EGP) sit in the wrong area; FIXED as a read-time respread from the October closing (PR #5676)."
metadata:
  node_type: memory
  type: project
  originSessionId: 61ac0cfb-9a45-4123-ac88-7f2173f492b1
  modified: 2026-10-09T14:23:35.940Z
---

The Office channel's value shares used to be computed when the Office file was uploaded and written
into the rows, and nothing re-ran them. So the "import Office last" discipline was necessary but not
sufficient: a distributor batch whose customers are re-resolved AFTER the Office upload moves the
non-Office value base, and the stored Office spread stayed on the old one.

**Measured on production, 2026-10-09, August 2026 CNS**, through the repo's own closing loader and
`buildOfficeRespread`. Office = 109,719 of 178,272 units (61.5% of the line); its last batch landed
10 Sep 19:15 Cairo, correctly after the brick-carrying channels, and the month was published 10 Sep
23:22. **6,834 packs — 6.23%, 548,777 EGP — are credited to a different area than today's base
gives them**, across 48 areas with 17 of them short; the largest single error is CA1 at +3,119 packs.
🔴 **TWO TRUE NUMBERS, ONE DEFECT — never "reconcile" them away.** `check-office-allocation-drift.ts`
(merged as #5679, another session) reports **3,698 units / 3.37%** by comparing the Office BATCH's own
rows with today's shares on the line's own stored total; **6,834 packs / 6.23%** is the same month
through the closing LOADER, after the city-split rails — where a reader meets the number, and what
this respread moves.

**FIXED, not outstanding.** `src/lib/sales/closing-office-respread.ts` recomputes the spread on every
closing READ as a net movement on the city split's rails — the locked golden rule itself is
untouched — from `OFFICE_RESPREAD_START_PERIOD = "2026-10"`, CNS only, so no published month moves.
It shares the largest-remainder engine (`contribution-respread.ts`) with
[[epda-bulk-is-allocated-like-office-on-pedia-from-september-2026]], which is why that rule must not
copy the upload-time design either.

**How to apply:** August stays as published — the 6.23% is the evidence for the rule, never a
backlog. 🔴 **SEPTEMBER IS SETTLED: he was asked and ruled "leave the Office respread at October"**
(2026-10-09), with September's state in front of him — CNS not published (only September Anti
Infective is, and that line has no Office channel), still importing, and ZERO Office rows because
its file has not landed. So the constant moves again only on **his own new word about September**,
never on a session's reading that the data makes it look safe, and it would also need September's
frozen net rebuilt first — see [[publishing-one-line-freezes-the-whole-periods-store-split-net]].
