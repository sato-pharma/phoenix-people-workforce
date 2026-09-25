---
name: next-destination-stream-closed-early-is-a-browser-abort
description: "Production log error \"The destination stream closed early\" (digest 2714676938) is a browser leaving a page mid-load (HTTP 499), not a regression of the version just shipped"
metadata: 
  node_type: memory
  type: project
  originSessionId: 5171e67d-62fb-4044-b6ee-b1e39ba84bf3
  modified: 2026-09-18T16:51:38.717Z
---

`⨯ Error: The destination stream closed early.` with `digest: '2714676938'` in `railway logs` is Next.js reporting that the browser cut a streamed page off before it finished. It is not a defect in whatever version just deployed.

Measured on 2026-09-18, after #4059 shipped:
- Seven copies landed in one second, at 19:01:56 Cairo.
- In the same 25 seconds, `railway logs --http` showed 40 requests ending in 499 (client closed). Someone was clicking quickly through admin pages: Access, Company Calendar, Private Calendars, Payroll, the CEO command center. None of those were pages #4059 touched.
- The same digest had already appeared on two earlier versions that day, at 16:47 and 18:02.
- Deployments that lived only 8 to 9 minutes showed none, because nobody happened to navigate fast in that window. Zero on a short-lived version proves nothing.

**Why:** A post-merge log read found it, and it looked like a new error on the just-shipped version. Proving otherwise took five tool calls.

**How to apply:** When it appears after a deploy:
1. Take the second it fired and pull `railway logs --http --service phoenix-people-workforce --environment production --since <utc> --until <utc> --json`. Check that the 499 paths at that second are not the pages the change touched.
2. Grep an older, longer-lived deployment for the same digest. `railway deployment list --json` gives the ids; then run `railway logs <id> --json`.

Only three things are worth chasing: a different digest, a 5xx, or the changed page's own path. A Next.js upgrade can change the digest, so re-derive it rather than trusting the number. This is the server-side twin of [[script-error-is-never-app-code-65pct-of-client-errors]].
