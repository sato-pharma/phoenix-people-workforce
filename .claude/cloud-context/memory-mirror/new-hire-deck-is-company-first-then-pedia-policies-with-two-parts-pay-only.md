---
name: new-hire-deck-is-company-first-then-pedia-policies-with-two-parts-pay-only
description: "The Pedia new-hire presentation (16:9 PDF, built by the profile generator with PHX_DECK=nh) is the whole company profile condensed into six slides, then Pedia-only policies in three. Salary is shown as Two Parts only: never mention One Part or that there are two pay modes. Company payroll and rep pay ranges are in it, his call to keep."
metadata:
  node_type: memory
  type: project
  originSessionId: 0699131c-9b4a-4ab5-b5cd-5820bfbcb052
  modified: 2026-10-14T10:16:35.694Z
---

The owner, 14 October 2026: "summarize the pdf make it less pages and add in it salary payment policy
donot bmention the 1 paymode only talk about the 2 paymodes and put the illustration for pedia incentive
scheme i want turn it to a presentation pdf to new hires for pedia line". Then, correcting the first
cut: "the indroduction know your company is showing the full data and company history but in condensed
number of pages then el policies for pedia onl;y".

**Shape (9 slides, 960 x 540 pt):** Part A, "Know your company", is six slides that carry every data set
and the history of the 10-page profile: cover, who we are (history timeline), then-and-now with sales
growth, lines with people, the road with the team's growth, pay with the network. Part B, "Pedia
policies", is three slides: salary paid in two parts, the incentive rule (Sato half and Total half),
the curve with worked examples. The Pedia "your line" slide was dropped, because the Pedia card on the
lines slide and the incentive slide already carry it.

**Why:** Part B must not mention a first pay mode or the existence of two modes, and the introduction
is not to be cut down to a teaser: he wants the full facts in fewer pages. The incentive basis is Basic
Salary (70% of Base), which never moves with additions, deductions or expenses; the curve is read from
`src/lib/incentives/pedia-split.ts` (the locked `scheme-2026.ts` was only read).

**How to apply:** build with `PHX_DECK=nh node tools/build-profile.mjs <out> <repo> <assets> nh01,p02,nh03,nh04,nh05,nh06,nh07,nh08,nh09`
from the session scratchpad, always into a separate output folder. Open items he has not settled: 151
seats versus 154 (three office-support staff are not seats), the pay basis of the 2021 and 2025 ranges,
and the price basis of the 850 M beside the factory-price 2015 to 2020 columns. Related:
[[owner-sets-2026-yearly-sales-at-850m-and-top-rep-pay-at-21500]], [[branding-pieces-are-charts-not-paragraphs]].
