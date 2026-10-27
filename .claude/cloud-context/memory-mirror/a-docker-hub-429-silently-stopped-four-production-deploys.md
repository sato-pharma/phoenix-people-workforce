---
name: a-docker-hub-429-silently-stopped-four-production-deploys
description: "Four green merges in a row failed to deploy on `docker.io/library/node:24-alpine: 429 Too Many Requests` — a shared-builder Hub rate limit, invisible everywhere except the Railway build log, fixed by pulling the base image from public.ecr.aws"
metadata:
  node_type: memory
  type: project
  originSessionId: abf9f7ad-6d41-471f-84f7-43a58d29f3a1
  modified: 2026-10-09T21:43:41.721Z
---

On 2026-10-09 between 23:43 and 23:58 Cairo, **four consecutive merges to `main` — #5711, #5712,
#5713, #5714 — each produced a FAILED Railway deployment**, and production stayed on
`e2f05f903` (PR 5709, 23:34). Every build died on the same line:

```
failed to solve: node:24-alpine: failed to resolve source metadata for
docker.io/library/node:24-alpine: 429 Too Many Requests
```

Nothing in the repository was wrong: each PR was green, `main`'s own CI for each merge sha read
`completed/success`, the service read `● Online` and served the previous revision happily, and
`/api/healthz` answered `ok`. **The only place the failure existed was the Railway build log.**
Railway builds on shared metal, so the anonymous Docker Hub pull limit belongs to the builder's IP,
not to this project — four builds in fifteen minutes was enough to trip it.

**Why:** this is the deploy gate failing by not shipping, reached from a new direction. The known
shape is Railway's "Wait for CI" withholding a deploy; this one passed CI and then could not fetch
its base image. Both end the same way — merged, green, and not live — and neither turns anything
red. `verify-shipped.mjs` named it correctly (`NOT LIVE`, four `failure` rows), which is why the
twenty-minute background wait returning `STILL QUEUED` was worth reading rather than shrugging at.

**How to apply:**
- A `NOT LIVE` verdict with `failure` deployment rows is a **build** failure, not the CI gate — read
  `railway logs --build <deploymentId>` (the flag takes the id as a positional; `--build` with
  `--deployment` is refused, and a bare `railway logs --build` reads the LAST SUCCESSFUL deployment,
  which is how a failed build can show you `Healthcheck succeeded!`). `railway deployment list`
  gives the ids and their states.
- The fix shipped in the Dockerfile: `FROM public.ecr.aws/docker/library/node:24-alpine`, AWS's copy
  of the Docker Official Images, which never falls back to Hub. Byte-identical — Hub, `mirror.gcr.io`
  and `public.ecr.aws` all answered digest `sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1`
  for `24-alpine` on the night. Pinned by rule 8 of `tests/railway-deploy-config.test.ts` in the
  required `validate` job, asserted on `^FROM` lines so the incident comment can quote the Hub path.
- **Recovery is the next successful deploy, never a re-merge**: a merge that builds carries every
  stranded commit forward at once. Only the owner redeploys by hand, in the Railway dashboard.
- 🔴 **DO NOT KEY A CHECK, A GREP OR A WATCHER ON THE STRING `429` — THE LAST OF THE SEVEN FAILED
  DIFFERENTLY.** `673e24ec5` (00:26 Cairo) died one step earlier than the other six, with
  `504 Gateway Timeout` out of `https://auth.docker.io/token` instead of `429 Too Many Requests`
  from `registry-1.docker.io/v2/library/node/manifests/24-alpine`. Same anonymous path, collapsing
  under the load rather than refusing politely, and the same cure. Match on the registry HOST in the
  `failed to solve` line, never on the status code.

**Proven, the same night.** The fix shipped as PR 5719 (which merged PR 5718's branch whole; two
sessions fixed the same outage two minutes apart, and the duplicate plus an overtaken roll-up were
closed rather than merged). Merged `fab743655` at 00:32:21 Cairo, deployment `1da8f081` SUCCESS at
00:32:26, live at **00:42:47** — the first build to pull from the mirror passed, and all seven
stranded merges (5711, 5712, 5713, 5714, 5716, 5717, 5719) became ancestors of the serving revision
in that one deploy. Seven consecutive FAILED builds preceded it.

**Detecting it from GitHub, not from Railway.** The deploy failure mode already in `AGENTS.md` §2 is
Wait-for-CI holding and then SKIPPING — a deployment that is never created at all. This is the
opposite shape: the deployment **is** created, reaches `in_progress`, and then dies in the build, so
*"a deployment exists for my sha"* is not evidence either. The states as the API gave them:

| Commit | PR | Merged (Cairo) | Deployment state |
| --- | --- | --- | --- |
| `292113a46` | 5711 | 23:43 | failure |
| `ab46f410a` | 5712 | 23:50 | failure |
| `ba21afa2a` | 5713 | 23:54 | failure |
| `d7d862603` | 5714 | 23:58 | failure (twice — the retry failed too) |
| `fab743655` | 5719 | 00:32 | success |

- The cheap signal, needing no Railway CLI:
  `gh api repos/it-gawish-hr/phoenix-people-workforce/deployments/<id>/statuses --jq "[.[].state]"`.
  A `failure` there under a green CI means the BUILD died, not the code.
- **Compare `/api/healthz` `revision` to `origin/main`, never to your own commit** — a revision that
  is neither is the tell that an intermediate deploy died.
- **No work is lost, and say so plainly.** `main` is linear, so the next successful deploy carries
  every stranded commit. Verified with `git merge-base --is-ancestor`: all four of `292113a46`,
  `ab46f410a`, `ba21afa2a` and `d7d862603` are ancestors of `fab743655`. "Four merges shipped
  nothing" sounds like four things to redo — it was ~1.5 hours of production lag, nothing to re-merge.
- **Date every revision reading.** `main` took 14 commits between 22:24 and 00:32 Cairo that night, so
  a reading goes stale in minutes: a peer's 19:39Z reading of `97f107fb0` looked like a live
  contradiction of `fab743655` read at 22:06Z, when it was simply older.

Related: [[a-locked-closing-blocks-a-rollup-rebuild-on-an-unlocked-line]].
