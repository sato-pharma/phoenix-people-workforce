---
name: railway-config-plan-needs-the-native-exe-on-windows
description: "`railway config plan` fails here with 'requires Railway CLI 5.42.1 or newer' although the CLI is 5.59.0 — the SDK runs `execFileSync(process.env._ || 'railway', ['--version'])`, which cannot run the npm `.cmd` shim and gets bash's `_`; run from PowerShell with `$env:_` set to the native `…\@railway\cli\bin\railway.exe`, with the SDK installed in a SCRATCH folder, never the repo"
metadata:
  node_type: memory
  type: project
---

Measured 2026-10-10 while planning the Railway IaC apply (owner lifted the 2026-10-01 "leave the
railway IaC inert" hold that day: *"lift the Railway IaC hold and plan the apply"* — the PLAN only;
the apply is a separate word from him).

Three failures stacked, each reading as a different problem:

1. **`The Railway TypeScript SDK is not installed`** — the authoring file imports `railway/iac` and it
   is NOT a repo dependency. Install `railway` into a scratch folder that holds a copy of the file
   (`npm install railway@3.13.1 --ignore-scripts`, official package, no install scripts), and pass
   `--file`. Never `npm`/`pnpm add` it in the repo or a worktree (AGENTS.md §5 purges the
   `node_modules` junction).
2. **`requires Railway CLI 5.42.1 or newer`** with CLI 5.59.0 installed — a false version error. The
   SDK shells out to `process.env._ || "railway"` with `--version`. From Git Bash `_` is the path of the
   last command, and bare `railway` is an npm `.cmd` shim that `execFileSync` cannot run, so both throw
   and the SDK reports the old-CLI message.
3. **The fix** is PowerShell, `$env:_ = "$env:APPDATA\npm\node_modules\@railway\cli\bin\railway.exe"`,
   then `& $exe config plan --file <scratch>\.railway\railway.ts --verbose --out <plan>.json`, run from a
   directory linked to `Phoenix-HR-Workforce` / `production` (the primary is). It exits 0 with no apply.

**What the plan said** (against `origin/main` blob `1307f7fef`, merge `00e2cdbc0`): 0 add, 3 change,
0 destroy, and NO variable touched — so the refreshed 107-name list matches live, which is the drift
test the docs ask a `pull` to do. The three changes all write values the services ALREADY run with from
their `railway.toml`: app healthcheck `/api/readyz` / 300 / `ON_FAILURE` / 10, and `phoenix-headwind`
`builder DOCKERFILE` + `ON_FAILURE` / 10.

**Not answered by a plan, and the reason an apply needs his word:** whether storing service settings
makes Railway REDEPLOY the service. For the app that is a build that must pass the readiness gate; for
`phoenix-headwind` it would restart the MDM server every rep tablet checks in to.

**The `--out` file pins `git rev-parse HEAD:.railway` of the directory it ran in** — the primary sat on
stale `fab743655`, so that plan's source tree is NOT the merged file. Re-plan from a checkout of the
merge before any `--plan` apply.

Related: [[a-docker-hub-429-silently-stopped-four-production-deploys]].

## The apply, 2026-10-10 01:35:05 Cairo — his words: "apply the app-only plan"

He ordered the app-only apply after ruling **"leave phoenix-headwind out of the first apply"**; the
scratch copy of the file dropped headwind's `builder` and `deploy` lines only, so the plan read 0 add /
1 change / 0 destroy. Re-planned the minute before (no drift), then `config apply --yes` (no
`--confirm-destructive`: nothing to destroy). Exit 0, "Changes (1)".

- 🔴 **AN APPLY REDEPLOYS THE SERVICE.** Deployment `8416c821` went BUILDING nine seconds later, rebuilding
  the SAME commit — so `/api/healthz` `revision` does NOT move and cannot be the proof; read the
  deployment's own status and the build log. Wait for any in-flight `main` deploy first or the two
  cannot be told apart. `phoenix-headwind` did NOT redeploy (still SKIPPED), so an apply that leaves its
  fields alone leaves the MDM server alone.
- 🔴 **THE RESTART POLICY IS NEVER STORED.** After the apply the healthcheck path/timeout read back, but
  `restartPolicyType`/`MaxRetries` still plan as `null → ON_FAILURE/10`, and will on every plan: Railway
  applies them from `railway.toml` at deploy time and the engine cannot persist them. **His ruling:
  "keep railway.toml until the restart policy is stored"** — never delete it on the strength of the
  healthcheck alone.
- A `pull`-then-`plan` loop reads that line as pending forever; do not chase it as drift.
- **The second apply (`phoenix-headwind`) ran 2026-10-10 01:51 Cairo on his "apply the phoenix-headwind plan".** Plan 0/3/0, exit 0, "Changes (2)"; it redeployed the MDM server (deployment `2d849e38`, built from its own Dockerfile, SUCCESS in ~90s) and `builder: "DOCKERFILE"` now stores. The app also got a new WAITING deployment behind `main`'s CI gate, so an apply queues one even with nothing changed on it. Docs record it in PR 5729.
