---
name: donot-use-dev-for-the-look
description: "2026-11-09 ~02:30 Cairo the owner said \"DONOT USE DEV\" while a session drove the spare's dev server for a browser look — verify by tests and code instead unless he asks for a look."
metadata:
  node_type: memory
  type: feedback
  originSessionId: 7d0ce61e-56cc-4dc1-a01c-37635cf7a618
  modified: 2026-11-09T00:03:47.509Z
---

On 2026-11-09 (about 02:30 Cairo), mid-task on Hany Saad's screens, a session drove `localhost:3000` (the spare laptop's dev server) with the run-phoenix-workforce driver to reproduce "no back button when I press a rep". He interrupted: **"DONOT USE DEV"**.

**Why:** his words, unexplained; the spare's dev server serves production's data and is his to run (see [[spare-laptop-runs-the-dev-server]]), and the driver signs in as a real person (PD-0001) on PRODUCTION.

**How to apply:** do not open or drive the dev server (local or the spare's) on your own initiative for a look. Prove a UI change with a source-pinning test that is broken and seen to fire, and the PR's CI; take a browser look only when he asks for one in that session ("Check before merge", "i want to see the browser verify").
