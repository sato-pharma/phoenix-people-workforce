---
name: the-fallback-restore-leaves-the-pull-token-on-the-website
description: "The fallback image route's `restore` reconnects the website to git but never removes the image-pull credentials `switch` saved, so a GitHub token sat in production's Railway config after a fallback switch. Cleared 19 Nov 2026 00:21 Cairo on the owner's 'Clear the token' with environmentPatchCommit (registryCredentials: null, skipDeploys) — serviceInstanceUpdate cannot clear it."
metadata:
  node_type: memory
  type: project
  originSessionId: fb7acb22-dea4-40c6-b1bb-b67f01bff48a
  modified: 2026-11-18T22:56:25.584Z
---

**What happened.** The 18 Nov 2026 Railway audit found a GitHub classic token in the website service's production
`deploy.registryCredentials` (probably the fallback route's `GHCR_PULL_TOKEN`). The website builds from git, so
Railway never used it. Cause: `scripts/fallback-image-deploy.mjs` `switch` sets `source{image}` + `registryCredentials`
through `serviceInstanceUpdate`, while `restore` only called `serviceConnect` back to git and never removed the
credentials. **FIXED by PR 545** (owner: "Fix it here", then "Merge 545 when green"; merged 19 Nov 2026 00:37
Cairo as cb31e8821, live 00:40, main CI green, no new errors in 15 min): `restore` now sends the clearing patch right
after each reconnect and ends red if Railway refuses it; pinned by `tests/fallback-image-deploy.test.ts` section 4.

**Cleared 19 Nov 2026 00:21 Cairo** (owner: "Clear the token"): `railway api` mutation `environmentPatchCommit` on
production with patch `{services:{<website id>:{deploy:{registryCredentials:null}}}}` and `skipDeploys:true`. Patch
status COMMITTED, no error; read-back shows no registry field anywhere in production or staging; source still
`main`, healthcheck and region intact; no deployment started; production `/api/readyz` 200.

**How to apply:**
- `serviceInstanceUpdate` cannot clear it — `RegistryCredentialsInput` needs both username and password. Railway's
  environment schema allows `registryCredentials: null`, and the environment patch removes the field.
- From node, start the CLI by its full path, `C:/Users/satoh/AppData/Roaming/npm/node_modules/@railway/cli/bin/railway.exe`
  — `spawnSync("railway.exe")` without a shell finds nothing (the npm shim is `railway.cmd`).
- Read registry fields by NAME only (SET/empty), never print the value.
- Revoking the token on GitHub is the owner's. If it is `GHCR_PULL_TOKEN`, the fallback route then needs a new
  read-only package token saved under that name, minted by him. Related: [[the-repo-railway-token-is-dead-and-the-fallback-needs-an-account-token]].
