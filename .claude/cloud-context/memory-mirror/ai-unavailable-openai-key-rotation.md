---
name: ai-unavailable-openai-key-rotation
description: "\"AI unavailable — manual review\" root cause = bad/missing OPENAI_API_KEY per environment; fix = Secret Manager key rotation + wiring"
metadata:
  type: project
---

All Phoenix AI features gate on ONE env var, `OPENAI_API_KEY` (Secret Manager secret of the same name): sales weekly-verify ("AI unavailable — manual review" badge), normalizer AI-suggest/AI-explain (`src/lib/sales/ai/provider.ts`), AND email AI-assist + payroll copilot (`src/lib/ai/openai-client.ts`, models gpt-5.4-nano / gpt-5.4 via Responses API). All degrade gracefully to `aiUsed=false` — an AI outage never blocks uploads, it just shows "unavailable / manual review". So "AI unavailable" is almost always a KEY problem, not a code bug.

**2026-07-19 incident+fix:** Owner saw "AI unavailable" on PROD. Diagnosis: prod `phoenix-hr` (europe-west3) referenced secret `OPENAI_API_KEY:latest` = version 1 (created 2026-07-16), which was invalid/unfunded → every AI feature dead. Staging `phoenix-hr-staging` (us-central1) had NO OPENAI_API_KEY wired at all. Local `.env.local` key was valid+funded (tested HTTP 200 on gpt-4o-mini AND gpt-5.4/-nano).

Fix (no code change): validated the local key live, pushed it as secret **version 2**, then pinned BOTH services to `OPENAI_API_KEY:2` via `gcloud run services update <svc> --region <r> --update-secrets=OPENAI_API_KEY=OPENAI_API_KEY:2` (prod rev 00058-2fg, staging rev 00153-5n6). Shared runtime SA `phoenix-hr-run@phoenix-workforce-498619` already had `secretmanager.secretAccessor`, so staging needed no IAM change. Health verified on the public prod domain + staging.

**Key facts for next time:**
- Prod ref was pinned to explicit `:2` (not `:latest`) to force a deterministic revision roll. **Rotation runbook:** add a new secret version, then `services update --update-secrets=OPENAI_API_KEY=OPENAI_API_KEY:<N>` on BOTH `phoenix-hr` (europe-west3) and `phoenix-hr-staging` (us-central1). A `:latest` ref does NOT auto-roll prod's warm (--min 1) instance — a new revision is always required.
- Deploy workflows use `--update-env-vars` (merge) and never touch `--set-secrets`, so manual secret-ref changes PERSIST across CI deploys. See [[notification-outages-cloudrun-env-drift-2026-07-11]].
- Never read/print the secret value; the auto-mode classifier (correctly) blocks dumping the prod service JSON. ~~Move keys via stdin pipe to `gcloud secrets versions add --data-file=-`, never argv/stdout.~~ **[RETARGETED 2026-08-27: the never-print-a-secret principle STANDS and is the point of this line — only the mechanism died. GCP is `BILLING_DISABLED`; set the key as a **Railway** variable on `phoenix-people-workforce` / `production`, then wait for the deploy that the variable change ITSELF triggers to reach `SUCCESS` (corrected 2026-08-28 — the "Railway does not restart on a var change" claim that stood here read a build's minutes-long latency as an absence; do not fire an extra `railway redeploy`, that is a second build of the same commit. `AGENTS.md` §2.3). Verify by fingerprint, never by printing the value.]**
- Secret v1 (bad key) left enabled but unreferenced — optional hygiene to disable.
- Owner declined a code change to surface the specific failure reason (out-of-credit vs key-rejected vs not-configured) in the weekly-verify badge — still a vague "AI unavailable — manual review".
