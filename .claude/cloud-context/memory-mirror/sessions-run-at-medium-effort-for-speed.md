---
name: sessions-run-at-medium-effort-for-speed
description: Owner set default effort high -> medium on 2026-11-12 because sessions were slow to reach a PR; model thinking was ~75% of request-to-PR time
metadata:
  node_type: memory
  type: feedback
  originSessionId: 05394eea-c890-455c-b984-0ed842360cb5
  modified: 2026-11-12T21:07:02.399Z
---

Default `effortLevel` in `~/.claude/settings.json` is **medium** since 2026-11-12 ~23:10 Cairo, owner's pick ("Medium effort (Recommended)") after he said "PRS ARE VERY SLOW". Never flip it back to high unasked.

**Why:** measured 15 PR sessions on 2026-11-12: request -> `gh pr create` took 6-20 min (one 42), of which ~75% was model time between steps and ~25% tool time; GitHub CI was ~3 min (jobs start in 3 s), merge -> live ~8 min, hooks ~0.2 s per call. The pipeline was never the slow part.

**How to apply:** when he says PRs/sessions are slow, measure request->PR from transcripts first (model vs tool time) before touching CI. A single hard session (payroll, migrations) can be raised to high per session. Fast mode was offered and NOT chosen (uses more weekly usage).
