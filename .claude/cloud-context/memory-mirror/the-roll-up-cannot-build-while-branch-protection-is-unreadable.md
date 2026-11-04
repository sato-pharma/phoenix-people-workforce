---
name: the-roll-up-cannot-build-while-branch-protection-is-unreadable
description: "On Omar-3-xx/phoenix-people-workforce, reading main's protection answers 403 (needs GitHub Pro), so rollup-prs.mjs can confirm no check as green. Read 4 Nov 2026; re-read before trusting."
metadata:
  node_type: memory
  type: project
  originSessionId: 0a308a50-8d50-4a20-8bf9-cadaf718e21c
  modified: 2026-11-04T02:30:20.307Z
---

Read 4 Nov 2026 about 03:50 Cairo: `gh api repos/Omar-3-xx/phoenix-people-workforce/branches/main/protection/required_status_checks` answers 403, "Upgrade to GitHub Pro or make this repository public". `node scripts/rollup-prs.mjs` then prints "nothing could be confirmed green" on every open PR, even one whose checks all passed. A plan and an `--apply` run were read; an `--apply` that got as far as building was not, because the run I tried stopped earlier at "nothing to roll up" (PR 1 and the nightly mirror PR shared files).

**Why:** `requiredGateUsable` in `scripts/rollup-check-state.mjs` refuses a gate it cannot read, on purpose. It is correct; the account is what changed. With protection unreadable, `validate` and `checks` may not be enforced at merge either, so a red PR may merge.

**How to apply:** until protection reads, carry a small PR by adding its commit to the wide PR's branch and closing the small one, as PR 6 rode on PR 1 (merged 04:05 Cairo as `8e61d1047`). Read `validate` and `checks` by hand before any merge. See [[github-move-to-omar-3-xx-2026-11-04]].
