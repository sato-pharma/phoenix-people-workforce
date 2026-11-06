---
name: ci-runs-on-the-spare-laptop-until-money-returns
description: "From 2026-11-05 CI runs on his spare laptop (WSL2 self-hosted runner) as a TEMPORARY bridge while he has no money; when money returns, delete CI_RUNNER_LABEL and CI goes back to GitHub-hosted"
metadata:
  node_type: memory
  type: project
  originSessionId: 1187a57d-e12b-4357-8e3e-efdb550cf2b8
  modified: 2026-11-06T01:27:13.493Z
---

On 2026-11-05 (~23:00 Cairo) GitHub Actions stopped starting jobs on `Omar-3-xx/phoenix-people-workforce`: free plan, 2,000 included minutes used by 5 Nov (2,018), spending limit $0. He has no money for now ("temporarily have no money… after that I'll have money"). He chose, as a TEMPORARY bridge, his spare ASUS Vivobook TP470E (8 GB, Windows, WSL2 Ubuntu 24.04, 5 GB cap) as a self-hosted runner — PR 40, switch = repo variable `CI_RUNNER_LABEL=phoenix-ci`.

He refused: an Oracle VM (needs a card), the Enterprise trial (3,000 minutes total ≈ 7 days, repo must move), making the repo public, this laptop.

PR 40 merged 2026-11-06 01:25 Cairo (squash 33510373e). **Two runners** since 2026-11-06 (`phoenix-ci-Gawish-1`, `-2`; his "the fastest way"): ~12–15 min a PR, pull requests never build. He declined CircleCI (free minutes run out mid-month at ~12,000/month). The two Docker image workflows stay GitHub-hosted and show red (billing) — he approved merging over exactly those two for PR 40; ask again per PR.

🔴 **2026-11-06 ~02:00 Cairo: the repo MOVED to the organization `sato-pharma`** (`sato-pharma/phoenix-people-workforce`) on his "migrate the project to the trail enterprise" — he chose the Enterprise trial over my free-org recommendation. All 81 secrets, 5 variables, 3 environments and both runners came across. `CI_RUNNER_LABEL` was DELETED there, so CI runs on GitHub-hosted runners on the org's own minutes (free org: 2,000/month; trial adds 3,000 total). Why: two laptop runners OOM'd on main's production build (validate cut off, unit (2) lost its runner). The trial must hold the EXISTING org (personal-accounts type) — an org CREATED in a trial cannot leave it unpaid, and trial enterprises are deleted 90 days after an unpaid end. When the org's minutes run low, set `CI_RUNNER_LABEL=phoenix-ci` again (ONE runner for main's build).

2026-11-06 ~03:40 Cairo: the trial invitation was accepted — `gh api orgs/sato-pharma` reads `plan: enterprise, seats 50` (enterprise `sato-pharma-phoenix`, 31 days from 6 Nov → ends about 7 Dec 2026; unpaid, the org drops back to free). Railway's app is installed on sato-pharma and all 5 sources/triggers re-pointed (PR 44, live 03:08 Cairo); `delete_branch_on_merge` had been reset to false by the move and was turned back on. The fallback image exists at `ghcr.io/sato-pharma/phoenix-people-workforce:a3f9736fe`.

**Why:** no money, no card; own-machine minutes are not billed.
**How to apply:** when he says money is back (or the GitHub budget is raised), the switch back is `gh variable delete CI_RUNNER_LABEL --repo Omar-3-xx/phoenix-people-workforce` — nothing else to rebuild. Never move the repo into an organization or start the Enterprise trial for minutes. A one-off cloud routine (RemoteTrigger) ran PR 39's full checks and passed (2,875 tests) — usable as a stand-in only with his explicit word to merge and record the release-gate row.
