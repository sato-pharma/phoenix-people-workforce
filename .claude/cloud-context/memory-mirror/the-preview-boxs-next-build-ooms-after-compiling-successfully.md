---
name: the-preview-boxs-next-build-ooms-after-compiling-successfully
description: "remote-check.mjs build on the Hetzner box now dies `Killed` with exit 137 — an OOM during \"Collecting page data using 3 workers\", AFTER `✓ Compiled successfully`, in ~300s where the measured figure was 112s. Exit 137 is not a code error and must not be read as one; the GitHub runner's own Build step is green, and `remote-check all` is lint+typecheck+test only, so the build is the one PR-invisible stage with no local proof."
metadata:
  node_type: memory
  type: reference
  originSessionId: 369b9c60-2032-48eb-8853-ad2148939e4f
  modified: 2026-10-03T22:51:46.821Z
---

`node scripts/remote-check.mjs build` on the preview box (`phx@46.225.184.142`) now **fails with
`Killed` and exit code 137** — SIGKILL, i.e. the kernel's OOM killer. Measured twice on 2026-10-04,
at 301s and 310s.

**Read the stage it died in, not the exit code.** Both runs printed `✓ Compiled successfully in
4.7min` and then died in `Collecting page data using 3 workers`. So:

- **Compilation succeeded**, which is the stage that catches a client/server boundary violation — a
  client component importing server-only code fails Turbopack, not page-data collection. A build
  that OOMs after compiling therefore still carries real information.
- **The measured figure in `CLAUDE.md` is 112s for a full `next build`** (2026-09-30). It is now
  ~300s to the OOM, so the box's build has degraded with repo growth, independently of any branch.

**It is not the repo and not your change.** `main`'s own CI run executes a `Build` step inside
`validate`, and it was **green on `365b120e9`** the same night. Check that before spending a
minute on a build failure from the box.

**The coverage gap this leaves.** `remote-check all` is **lint + typecheck + test** — it does not
include `build`. And a PR's CI does not run the build either (`validate` builds only on non-PR
events). So the build is the one stage with no proof until the commit is on `main`, where a failure
does not go red loudly — it makes Railway **withhold the deploy**, which looks exactly like a
successful one until `/api/healthz` `revision` is read. Verify the revision after every merge; see
[[a-merge-is-not-a-deploy-read-healthz-revision]].

Related: [[four-module-guards-a-new-phoenix-crm-screen-must-pass]] — the `test` stage of the same
script is the cheap way to find those, and it does finish.
