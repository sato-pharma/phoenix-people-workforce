---
name: the-repo-is-private-since-2026-11-27
description: "27 Nov 2026: the main repo went private at 08:18 Cairo, then the owner decided at 10:49 to KEEP IT PUBLIC to avoid the Actions cost; going private disconnected Railway's git source from every service"
metadata:
  type: project
  originSessionId: 059d84db-9c96-426c-807e-834f091f9cb3
  modified: 2026-11-27T08:49:39.450Z
---

🔴 **OWNER DECISION, 27 Nov 2026 10:49 Cairo: "I WILL KEEP ON PUBLIC TO AVOID THE COST OF ACTIONS."**
`sato-pharma/phoenix-people-workforce` stays **public**. Plan nothing on a private repo, the Enterprise trial or a
self-hosted runner. This supersedes the earlier same-day choice ("Private + Oracle runner"), and
[[the-repo-is-public-since-2026-11-07]] holds again.

What happened that morning, measured:
- The repo was made private at **08:18:58 Cairo** (org audit log, `repo.access`). The trigger was the public
  tree holding a filled April payroll — that file still has to leave the public tree some other way.
- 🔴 **Going private disconnected Railway's git source from EVERY service.** The project Phoenix-HR-Workforce
  then reported no git-sourced service instance at all (`secret-drift-check` run 45968378591; the day before,
  six instances read `sato-pharma/phoenix-people-workforce@main`). Railway raised no error and no SKIPPED row:
  the last production build was 07:47 Cairo (`33eb5dd36`), and PRs 820 and 821 merged afterwards without
  deploying. Making the repo public again does NOT reconnect them; each service's source and deployment
  trigger has to be connected again.

**Why:** a public/private switch silently stops every deploy, and a private repo pays for Actions minutes.
**How to apply:** never change the repo's visibility without his word; after any visibility change read
`node scripts/check-railway-deploy-triggers.mjs` (or the drift-check run) and the live `/api/healthz` revision.
