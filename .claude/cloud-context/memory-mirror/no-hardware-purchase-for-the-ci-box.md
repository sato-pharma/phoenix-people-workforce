---
name: no-hardware-purchase-for-the-ci-box
description: "The owner will NOT buy a bigger or second Hetzner box (2026-10-08: \"i will not buy anything now\"; also refused a 2-box purchase on 2026-09-28) — never propose, price or put in the Next step box a server upgrade (perf plan Option C / P2-1); work within the 4 vCPU / 7.7 GB box."
metadata:
  node_type: memory
  type: feedback
  originSessionId: 6a8bf024-0835-4d85-b715-0e9995210381
  modified: 2026-10-08T13:53:56.364Z
---

On 2026-10-08, after the performance plan's other items shipped (#5500, #5512–#5514, #5517, #5526),
a session put "price a 32 GB Hetzner box for the CI box (Option C)" in the Next step box. The owner
answered: "i will not buy anything now". He had already refused a two-box purchase on 2026-09-28.

**Why:** spending on hardware is his decision, he has made it twice, and offering it again costs him a
turn to refuse it a third time.

**How to apply:**
- Do not propose, price or quote a box upgrade, a second box, or more RAM for the box. That covers the
  Next step line, plans and summaries.
- Treat the box as fixed: 4 shared vCPU, 7.7 GB RAM, one heavy run at a time.
- Speed work goes into software: the PR's own CI as the verdict, the warm lint cache, memory caps on
  the previews, and less hook overhead.
- Raise hardware again only if he does.
- The laptop's own RAM upgrade (2×16 GB SODIMM) is a separate matter, recorded in the global rules.
  Do not push that either.

Related: [[box-run-setup-is-five-seconds-warm-slots-not-worth-it]].
