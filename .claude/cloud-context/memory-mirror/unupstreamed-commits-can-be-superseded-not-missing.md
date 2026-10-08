---
name: unupstreamed-commits-can-be-superseded-not-missing
description: "`repo:doctor`'s \"N commits neither upstream by patch-id NOR applied on main as a delta\" can mean the branch holds a design main DELIBERATELY REPLACED — re-applying it reverts a decision. Read what main does instead before opening a PR for the gap."
metadata:
  node_type: memory
  type: project
  originSessionId: 6591b3bf-083c-4444-bb06-41a2779e5795
  modified: 2026-10-08T00:00:00.000Z
---

Measured 2026-10-08 on `_wt-crm-fraud-scan` (`codex/crm-fraud-scan`, tip `7702c9f35`), which
`repo:doctor` had flagged for days as NOT retirable: "PR #5427 merged, but 4 commit(s) on this branch
are neither upstream by patch-id NOR applied on `main` as a delta."

**What the four actually were.** Commits 1 and 2 ARE on main — the squash `4d6ba14c7` carries them,
and the patch-id test simply cannot match one member against a combined squash. Commits 3
(`b0e0cfb66`) and 4 (`7702c9f35`) are genuinely NOT on main. But both are **superseded**, and
re-applying either would revert a deliberate decision:

- Commit 4 moved the words "fraud"/"integrity"/"flagged" out of `fraud-scan-rules.ts` into a new
  `server/fraud-scan-summary.ts`, to satisfy Golden Rule #1's blind half. Main instead puts
  `fraud-scan-rules.ts` on `REP_FACING_PURE_EXCLUDED` in `tests/phoenix-crm-blind-half.test.ts` and
  keeps `"fraud-scan"` in `SILENT_MODULES`, so check 2 refuses the import from every rep-facing file.
  Enforcement by IMPORT GRAPH, not by word hygiene — the stronger of the two, and `fraud-scan-summary.ts`
  does not exist on main at all.
- Commit 3 re-pointed the weekly notice from `/admin/phoenix-crm/integrity` to
  `${PHOENIX_CRM_PORTAL_PATH}?tab=reports&section=exceptions`, on the premise that `/admin/phoenix-crm`
  is the retired 2026-09-14 pilot. Main keeps the admin path on purpose: the isolation regex in
  `tests/phoenix-crm-boundary.test.ts` whitelists exactly four sub-paths — `integrity`, `duplicates`,
  `refused-readings`, `list-template` — "this module's own admin screens", named one at a time so a real
  pilot link cannot ride in behind them. `system-navigation.ts:4332` grants it to
  `["Super Admin", "SFE Manager"]` with `phoenix_crm:read`, the page enforces it server-side
  (`canAccess` then `canReadIntegrityBoard`, else redirect), and the owner's own 2026-09-26 ruling is
  quoted there: "recorded in the admin and the SFE account". So the SFE Manager CAN open the link, and
  commit 3's premise is false against main as it now stands.

**How to apply.** That doctor line answers "is this branch's history on main", never "is this branch's
work still wanted". Before opening a PR for the gap, read what main DOES instead — the test that pins
it, the nav entry, the page's own guard — because a branch that lost an argument looks identical to one
that was forgotten. The branch is also fully safe either way: `refs/heads/codex/crm-fraud-scan` is still
on origin at the tip, so nothing is at risk while the question is open.

Related: [[a-squash-merge-makes-a-stacked-branch-rebuild-not-merge]],
[[verify-the-emitted-artifact-never-the-source]],
[[never-hand-roll-a-rule-the-repo-already-implements]]
