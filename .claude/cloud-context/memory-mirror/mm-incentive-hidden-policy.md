---
name: mm-incentive-hidden-policy
description: "Shipped policy: Marketing Manager is HIDDEN from the portal Incentive tab; GPM still sees it. Don't revert it."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: aebaa85c-e5f9-4fe9-9978-a415bdad5184
---

**Policy (owner-confirmed 2026-06-28):** in the employee portal, **Marketing Manager does NOT see the Incentive tab**; Group Product Manager still does. Encoded as `baseShowIncentiveTab = !isTrainingManager && !isMarketingManager` in `src/lib/employee-portal/navigation.ts`. The test `tests/employee-portal-navigation.test.ts` asserts MM `showIncentiveTab === false` ("hidden from MM per portal policy", aligned in PR #595).

**Why / lesson:** I saw `&& !isMarketingManager` land via an unrelated squash (bbea6c36) that broke the nav test, assumed it was an accidental edit, and shipped PR #596 to revert it — RE-breaking main, because the parallel session's #595 had *already* aligned the test to the intentional policy. Reverted my mistake via #598.

**How to apply:** before "fixing" a failing test by reverting the code that broke it, check whether a sibling/parallel PR already updated the test to match an INTENTIONAL change (`git log -S <assertion>` / look for a recent `test(...): align ... with shipped policy` commit). A code change that broke a test without updating it is NOT automatically a regression — it may just be mid-landing. Relevant to the chronic [[parallel-session-swarm-hazard]]: main churned red↔green repeatedly this day from concurrent merges. Also hit the [[ci-billing-block-and-unprotected-main]] gate (validate dying in ~1s = Actions billing, fixed by owner mid-task).
