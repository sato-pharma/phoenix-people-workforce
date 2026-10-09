---
name: the-closing-loader-falls-back-to-the-first-line-silently
description: "`loadMonthlyClosingPartsWithStoreSplit({line:\"cns\"})` returned Anti Infective's whole matrix for 2026-09 — no error, right period, every area populated — because the line is matched on its LABEL (`CNS`), so a restatement can print one line's money under another line's name; assert `matrix.line` before printing, and note area names carry no space (`Sohag1`)."
metadata:
  node_type: memory
  type: project
  originSessionId: 7d87f9ce-e2e0-4338-ba57-8b380f850d09
  modified: 2026-10-09T19:14:22.799Z
---

Measured 2026-10-09 while restating Sohag 1's September CNS on the new read-time Office spread.

`loadMonthlyClosingPartsWithStoreSplit({ line: "cns", period: "2026-09" })` came back with
`line: "Anti Infective"` — the first entry of `availableLines`. The period was the one asked for,
every region and area row was populated, no error and no warning. The only way to notice is to read
`matrix.line` back.

**Why:** the loader matches the line on its display LABEL, as `availableLines` spells it — `CNS`,
`Anti Infective`, `Pedia`. A lowercase `cns` matches nothing and the selection falls through to the
default, which is the first available line.

**How to apply:** pass the label exactly, and **assert `matrix.line` (normalised) equals the line you
asked for, and `matrix.period` the period, before printing or quoting any number** — this is the
cheapest possible guard against reporting a different line's money under the one he asked about.
Area names in the matrix carry no space: `Sohag1`, `Sohag2`, not `Sohag 1`. `scripts/restate-area-month.ts`
does both and is the tool for this question; it prints own sales, the Office credit as the closing
reads it now against the stored figure, the achievement each way, and the national conservation of
the respread. Related: [[sos-monthly-closing-is-the-only-sales-truth]],
[[a-customer-map-re-resolve-stales-a-pre-october-office-spread]].
