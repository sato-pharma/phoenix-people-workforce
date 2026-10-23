---
name: a-merge-burst-marks-earlier-production-deploys-failure
description: "when merges land faster than Railway builds, each superseded production deployment is stamped `failure` on GitHub and production stays on the last SUCCESS — read it as a queue, not as a broken deploy or a failed release gate"
metadata:
  node_type: memory
  type: project
  originSessionId: dd8bfcde-b7de-4cc2-9390-5e9a641ada7d
  modified: 2026-10-23T07:57:33.753Z
---

Measured 2026-10-23: **10 merges onto `main` in 45 minutes**. The GitHub production deployment rows for
`61d30f75f` (#6312) and `45967eb41` both read **`failure`**, five more read `in_progress`, and
`/api/healthz` `revision` sat on `7a9f1e345` — the last `SUCCESS` — for about 40 minutes. Nothing was
broken: each build was superseded by the next merge before it could finish, and both PRs read `SHIPPED`
once the train paused, because the live revision then contained them.

**Why:** a `failure` row looks exactly like the release gate's silent non-ship (AGENTS.md §2.3), which is
the one failure mode that leaves the old version serving with nothing turning red. The two are told apart
by the gate table, not by the deployment row: `select sha, recorded_at from public.release_gates` had
`61d30f75f` recorded at 07:30:50Z, **five minutes before** its deploy was stamped `failure` at 07:36:15Z —
so the gate had already passed and the cause was supersession.

**How to apply:** on a `failure` row, check `release_gates` for that sha and count recent merges before
reporting a deploy problem. Then judge shipping by **ancestry** — `verify-shipped.mjs` answers SHIPPED as
soon as the live revision contains the merge. Also: `?environment=production` does **not** match these rows;
the environment is literally `Phoenix-HR-Workforce / production`, and filtering on the short name returns
rows from July. Related: [[a-push-that-prints-new-branch-means-the-pr-already-merged]].
