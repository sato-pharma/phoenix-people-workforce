---
name: worker-follows-the-website-and-phoenix-cron-holds-a-dead-secret
description: "14 Nov 2026 (his choices): the worker's 26 plain copies of the website's secrets became Railway links, leaving only PHOENIX_PROCESS_ROLE and PHOENIX_LIVE_CRM_POLL as its own; the switched-off phoenix-cron service's CRON_SECRET is a dead placeholder on purpose — never put the live secret back."
metadata:
  node_type: memory
  type: project
  originSessionId: e77b7dd9-99fe-4c60-900c-6d4089fd2110
  modified: 2026-11-14T14:51:50.312Z
---

**What was found (14 Nov 2026, about 16:38 Cairo).** `docs/deployment.md` said every variable on `phoenix-workforce-worker` except its role is a link to the website's (`${{phoenix-people-workforce.NAME}}`). Live, 28 of its 121 were the worker's own plain copies, `CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY` and `PHOENIX_AUTH_SECRET` among them. The secrets sync writes the website only, so a changed secret would not have reached the worker. Three copies had already drifted (Brevo webhook secret, Cloudflare token, GitHub dispatch token); the worker reads none of those three.

**What he chose.** "All 27 follow the website (Recommended)", then "Drop phoenix-cron secret".

**What is true now.**
- Worker: 119 links, 2 of its own. The two are deliberate: `PHOENIX_PROCESS_ROLE` (`worker`) and `PHOENIX_LIVE_CRM_POLL` (the live poller's on-switch, which must be on in one place only). I counted 27 in the question and wrote 26; the poller switch is the difference.
- `phoenix-cron` (alpine image, no schedule, no deployment since 1 Aug 2026): its `CRON_SECRET` is the plain text `removed-2026-11-14-this-service-is-switched-off`. The NAME stays because `.railway/railway.ts` declares it `preserve()` and `tests/railway-iac-preapply.test.ts` expects the file to name it.

**Why:** the service's old start command would call production routes at UTC hours written as Cairo hours, and routes that now belong to the worker; with a dead secret every call is refused.

**How to apply:**
- A plain copy on the worker other than those two is drift, not design: make it a link with `railway variable set --service phoenix-workforce-worker --environment production --skip-deploys 'NAME=${{phoenix-people-workforce.NAME}}'`.
- Never "fix" `phoenix-cron`'s secret back to the live one, and never set a variable on it without `--skip-deploys`: a deployment STARTS the one-shot container.
- `docs/deployment.md` near line 578 still says `phoenix-cron` fires five production routes. It does not; correct it in the next PR that touches that file.
- To compare a service's values with the website's without printing them: resolved values from `railway variable list --json`, compared by sha-256; stored shapes from `railway environment config --json`. Run from the main checkout, not the scratchpad.

Related: [[the-secrets-sync-put-the-old-github-dispatch-token-back]], [[a-railway-variable-is-reverted-by-its-github-secret]], [[cron-job-org-is-the-real-production-scheduler]].
