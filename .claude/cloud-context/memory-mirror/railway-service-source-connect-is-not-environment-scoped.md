---
name: railway-service-source-connect-is-not-environment-scoped
description: "`railway service source connect -e staging` repoints PRODUCTION too — the source is a SERVICE-level setting and -e only resolves which service to look up, so a branch cannot be deployed to staging without deploying it to production as well"
metadata: 
  node_type: memory
  type: project
  originSessionId: 0cf5aa32-4d8c-4a73-9b79-a284b8c51694
  modified: 2026-08-28T04:41:56.043Z
---

**`railway service source connect --branch X --environment staging` DEPLOYED X TO PRODUCTION.**
Measured 2026-08-28 ~04:38 Cairo, on this repo, live.

The flag reads like `railway variables -e staging` (which IS environment-scoped, per
`AGENTS.md` §2.3). It is not. The CLI's own help says it exactly:

```
-e, --environment <ENVIRONMENT>  Environment to use for resolving the service
```

**"Resolving the service" — not "the environment to change."** The git source is a **service-level**
setting shared by every environment of that service, so connecting a branch repoints them all.

What happened, in order:

1. `service source connect --branch codex/retire-modules-control --service phoenix-people-workforce
   --environment staging` — intending a staging-only test of an unmerged PR.
2. Both environments began building that branch. `railway status --environment production` reported
   `ENV=production status=SUCCESS branch=codex/retire-modules-control sha=24f736bc`.
3. `https://phoenix-hr.satopharma.com/api/healthz` returned **`revision: 24f736bc`** — production
   was serving an unmerged feature branch at full traffic.
4. Staging served the same SHA. One command, both environments.
5. Recovery: `service source connect --branch main --service phoenix-people-workforce --environment
   production` — which likewise moved BOTH back, confirming the service-level scope from the other
   direction.

**So a branch cannot be deployed to staging here without also deploying it to production.** The
"smoke-test on staging before a risky production deploy" advice in AGENTS.md §7 cannot be executed
this way. Staging tracks whatever the service tracks. If a real pre-production test of an unmerged
branch is ever needed, it needs a SEPARATE Railway service, not a branch repoint — do not attempt it
with `source connect`.

**Two things that made this survivable, and neither should be read as "it was fine":**

- The branch was CI-green on all four required checks and verified across all 16 roles locally, and
  `sidebar_module_assignments` held 0 rows, so nothing behaved differently for a user.
- But production had silently **rolled back two commits merged minutes earlier** — `9689cb60`
  (#2508) and `35736e70` (#2509), both recruitment fixes. A green branch is still the WRONG code
  when it is older than `main`. That is the real cost, and `healthz` returning `status: ok` hides it
  completely — **read the `revision`, never the status.**

**Diagnostic trap that nearly buried the lead:** `railway status --environment X --json` returns the
project, and a parser taking `environments.edges[0]` reads the same environment no matter what `-e`
says. That made staging and production print identical lines, which looked like a parser bug and
almost got dismissed as one. **Always resolve by `environments.edges[].node.name`** and print the
name in the output — `scripts`-free readers for this live at
`scratchpad/prodstat.sh` / `stgstat.sh` in the 2026-08-28 session.

Related: [[railway-auto-deploy-can-silently-skip-a-race]] ·
[[railway-deploy-applies-no-migrations]] ·
[[a-merge-to-main-ships-to-production-immediately]]
