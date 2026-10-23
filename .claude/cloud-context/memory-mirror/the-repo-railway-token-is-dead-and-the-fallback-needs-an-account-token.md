---
name: the-repo-railway-token-is-dead-and-the-fallback-needs-an-account-token
description: "Fallback image route (PR 6224) PROVEN end to end 23 Oct 2026 04:45 Cairo: rehearsal run 39885039493 on e1f9375ae — gate, image and rehearsal green; a throwaway staging service pulled the private ghcr image with RAILWAY_API_TOKEN (the old RAILWAY_TOKEN is dead), its container started, it was deleted, nothing left over. It still cannot help during a platform-wide deploy pause (21-22 Oct). Production was never switched and need not be while Railway builds."
metadata:
  node_type: memory
  type: project
  originSessionId: 8c96a3de-85df-41cb-a725-a72d45953b97
  modified: 2026-10-23T01:46:25.340Z
---

✅ **PROVEN 23 Oct 2026 04:45 Cairo** (owner: "rerun the fallback-image rehearsal now that Railway deploys again").
Run 39885039493, ref e1f9375ae (main, release gate green): gate ✓, image ✓, rehearsal ✓ — service
`fallback-rehearsal-e1f9375a` in STAGING pulled `ghcr.io/gawish-1997/phoenix-people-workforce:e1f9375ae…` (deployment
be9e4158), its container started, the service was deleted, cleanup found nothing left. The "if it passes, run
`deploy=production`" step below was for a Railway that could not BUILD; Railway builds again, so production stays on
git and nothing was switched. Use `deploy=production` only on a future day Railway's builder is down but deploys work.

The fallback route (`.github/workflows/fallback-image.yml` + `scripts/fallback-image-deploy.mjs`, PR 6224) builds the production image on GitHub into ghcr.io and points Railway at it when Railway cannot build. Rehearsal = a throwaway staging service pulls the image, then is deleted.

**Token (fixed):** the repo secret `RAILWAY_TOKEN` (created 2026-08-09) was refused by Railway as both an account and a project token ("Not Authorized" / "Project Token not found"); it feeds `urgent-deploy.yml`, `sync-railway-production-secrets.yml` and `secret-drift-check.yml` too (the drift check only WARNS without a credential, so its green proved nothing). The owner stored a new token as `RAILWAY_API_TOKEN` at 16:25 Cairo on 2026-10-21; the workflow prefers that name (Authorization: Bearer). Use a WORKSPACE token (Railway lists it for team CI/CD); the script's failure-time check calls `me`, which Railway refuses for a workspace token, so its "refused as an account token" wording is not proof a workspace token is bad. `GHCR_PULL_TOKEN` (12:56Z) is separate and fine.

**Deploys paused (open):** run 39607933353 (16:34 Cairo, commit da6097396 = PR 6223) got past authorization and Railway answered `Deploys have been paused temporarily` on creating the rehearsal service. status.railway.com the same hour: "Dashboard and API unavailable, builds paused" (API back, features unavailable). So an image deploy is refused too: the fallback helps only when builders are down but deploys are allowed. The cleanup step confirmed no rehearsal service was left in staging.

**How to apply:** the owner approved (2026-10-21) "switch production to the GitHub image when the rehearsal passes" — the condition has NOT been met, so production was not touched. Re-dispatch the rehearsal (`gh workflow run fallback-image.yml --ref main -f deploy=rehearsal -f ref=<a commit whose release-gate passed>`) once Railway lifts the pause; if it passes, run `deploy=production`, `services=web` (worker stays on git), announcing first. A dispatch on main's newest commit is refused while its own CI has no release-gate row yet. Never mint or enter a token for him. See [[an-image-ref-in-root-directory-kills-every-production-build]] for the Root Directory trap the switch must not repeat.

**Second host (planned 2026-10-21, NOT started; owner chose "wait, keep the plan"):** running the GitHub-built image elsewhere (Render, Frankfurt, was the candidate; GCP and Vercel are dead, Hetzner is retired) is blocked by configuration, not by the image: the app code reads 157 settings and GitHub holds copies of only 44 (113 live only in Railway, among them ANTHROPIC_API_KEY, WHATSAPP_ACCESS_TOKEN and the GOOGLE_DRIVE_* keys), and Railway's dashboard was down. The worker `phoenix-workforce-worker` (CRM poller, heavy cron routes) must stay on Railway, never duplicated; the domain `phoenix-hr.satopharma.com` DNS switch is the owner's. Account creation, plan choice and DNS are his. The sheet of all 157 names was sent to him as `second-host-settings-the-app-reads.xlsx`.

**Rerun 2026-10-22 03:53 Cairo (run 39702386292, sha 8a1e9db51): same answer — gate and image green, rehearsal refused "Paused temporarily", cleanup ran, nothing left in staging.** Production's 03:22 move to 8a1e9db51 was the FLY emergency host redeploying (`server: Fly` header, emergency-host runs 03:12-03:33), NOT Railway — a new healthz revision is not evidence Railway deploys again; read the response's `server`/`via` header first.

**SUPERSEDED the same evening — production is on the Fly.io emergency host (verified 2026-10-21 20:12 Cairo):** another session built PR 6225 (`.github/workflows/emergency-host.yml`, `infra/fly-standby/fly.toml`, `scripts/emergency-host.mjs`) and 6227 (flip only to an issued certificate) and ran `go-live`; `phoenix-hr.satopharma.com` is now a Cloudflare CNAME to `phoenix-hr-standby.fly.dev` (Frankfurt), serving d8dbe9519 (main HEAD, so PRs 6218-6224 are live: `/login`, `/api/healthz`, `/api/readyz` all 200). The second-host plan above is therefore moot, and the owner's "DEPLOY THROUGH FLY.IO" was answered by that session, not this one. The standby is WEB ONLY; Railway's worker (old code, schedulers, CRM poller) stays put. `back-to-railway` is the OWNER's button once Railway serves again — never press or dispatch it, and never `railway up`/`redeploy` or the fallback-image `restore` while the domain points at Fly. Account: `docs/deployment.md` "The emergency host".
