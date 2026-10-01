---
name: hr-notification-emails-dropped-cloudrun
description: "HR_NOTIFICATION_EMAILS on Railway production — RESOLVED 2026-08-27 by APPENDING a real employee address so the employee-directory gate finally matches; the original shared mailbox matches no employee and never can"
metadata: 
  node_type: memory
  type: project
  originSessionId: 6dae059d-117a-4fde-aa3e-dc1706d915a6
  modified: 2026-10-01T00:00:00.000Z
---

Full env-var audit on 2026-07-17 (all 89 runtime `process.env` keys vs live Cloud Run env + Secret Manager + GitHub secrets) found exactly ONE real production gap: **`HR_NOTIFICATION_EMAILS` is unset on the live Cloud Run service** (`phoenix-hr`, revision phoenix-hr-00213-nax). It exists as a GitHub secret from the Vercel era but was dropped in the GCP migration — same drift pattern as [[notification-outages-cloudrun-env-drift-2026-07-11]].

It has NO default and is the sole source of the "HR inbox" recipient mode, so absence fails silently:
1. Every `"general"`-type notification email routes ONLY via `recipientMode: "hr_notifications"` → empty list → skipped with "routing resolved no recipient emails" (not an error). Goes to nobody.
2. HR loses its CC copy on probation / contract-renewal / resignation workflow emails (policies with `includeHrInbox: true`, `src/lib/notifications/email.ts`).
3. Excuse "HR-visibility" in-app/Telegram notifications reach nobody (`src/lib/excuses/service.ts resolveHrNotificationRecipients` returns `[]`).

**RE-VERIFIED LIVE 2026-08-27 — the diagnosis above is OUT OF DATE and the remaining failure has a DIFFERENT cause.**

- **The variable is no longer unset.** Railway `production` / service `phoenix-people-workforce` defines `HR_NOTIFICATION_EMAILS` with exactly **one** recipient: `phoenix@satopharma.com` (71 variables on that environment; only this key was read).
- **Items 1 and 2 above are therefore satisfied.** The email paths (`notifications/email.ts recipientsFromEnv()`, `email/recipient-assurance.ts:176`) take the raw comma/semicolon list with **no further filtering**, so they now resolve a recipient. Whether that mailbox is actually deliverable was NOT tested — firing a test email is forbidden (it also mirrors to the admin Telegram), so treat delivery as unproven.
- **Item 3 is STILL BROKEN, and setting the variable cannot fix it.** `resolveHrNotificationRecipients` has moved to **`src/lib/excuses/service.ts:379`** and is now a **two-gate** function: it reads the env list (gate one, passes), then **filters `directory.employees` by matching `workEmail`** (gate two). Production has **ZERO** employees with `work_email = phoenix@satopharma.com` — verified against `employees` (176 rows, 153 with a work email). So it returns `[]` exactly as before.
- **A shared mailbox can NEVER satisfy gate two.** That call sends on `channels: ["in_app", "telegram", "push"]` and keys idempotency on `hr.hrId` — it needs a real employee row, not an inbox. The fix is to point the variable at one or more **real employees' work emails**.
- Note `isHrVisibilityActor` is unaffected: Super Admin / CEO / Talent Acquisition are always actors regardless of this variable. Only the *recipient* side is empty.

This is the repo's recurring shape — see [[a-matrix-grant-is-only-gate-one-of-two]] and [[a-grant-can-die-in-a-filter-below-the-gate]]: the visible switch was flipped, and a filter underneath it quietly emptied the result.

**RESOLVED 2026-08-27 — owner chose Omar Anwar Gawish (B-10, Hr Manager); applied and verified.**

- Value is now `phoenix@satopharma.com,omar.anwar@satopharma.com`. **APPENDED, not replaced** — this one variable feeds three consumers, so overwriting it would have silently redirected the existing HR *email* routing, which was not what was asked. The shared mailbox stays for the email paths; the real address is what makes gate two pass.
- Applied with `railway variables --set ... --environment production --service phoenix-people-workforce --skip-deploys`, then `railway redeploy` (Railway does NOT pick up a variable change without one). Redeploy created **2026-08-26T21:31:32Z**, status **SUCCESS**, branch `main`, sha `70c1d231` — the same commit, so `/api/healthz` `revision` is UNCHANGED and cannot be used as proof here. Read the deployment `createdAt` from `railway status --json` instead.
- Gate two verified against production by replaying the function's own matching (`lower(trim(work_email))` against the configured list): `omar.anwar@satopharma.com` -> **B-10, Omar Anwar Ibrahim Ahmed Gawish, Hr Manager, active — MATCHES**; `phoenix@satopharma.com` -> **no employee row, contributes nothing** (and never will, since `in_app`/`telegram`/`push` key on `hr.hrId`).
- Not tested end to end: no excuse was submitted to force a real notification, and no test email was fired (forbidden — it also mirrors to the admin Telegram). The gate is proven by data, not by a delivered message.
- **Adding a second name later is just a comma** — Youmna Kotb (A-16, Talent Acquisition) is the obvious next candidate if HR-visibility should not depend on one person.

*(Filename still says `cloudrun`; kept deliberately so the existing index pointer does not break. The content, not the name, is current.)*

Canonical source confirmed by admin UI: "Use HR_NOTIFICATION_EMAILS only." (`src/components/admin/email-notification-center.tsx:76`). Read sites: `email.ts:358/609/673`, `recipients.ts:39`.

**Why:** Cloud Run runtime env is the source of truth and drifts from GitHub secrets across the migration; GitHub secrets are NOT auto-injected into the service.
**How to apply — ⚠️ REROUTED 2026-08-23, the original target no longer exists.** This said *"restore
on prod Cloud Run (`--update-env-vars HR_NOTIFICATION_EMAILS=<comma-list>`)"*. **GCP is dead** — billing
closed 2026-08-01, every API in `phoenix-workforce-498619` returns `BILLING_DISABLED`, and production
has been **Railway** since then. So this is still an **open owner action**, but it must now be done as a
Railway variable on service `phoenix-people-workforce`, environment `production` — not via `gcloud`.
Still owner-approved, still with the real HR distribution list, and per AGENTS.md §4 **ask who receives
it before wiring any email recipients**. Every other absent key (46) is safely defaulted /
intentionally-off / script-or-CI-only. See [[railway-is-prod-cloud-run-workflow-is-dead]].
🔴 Note the "Why" above still holds in the new shape: **the runtime environment is the source of truth
and drifts from GitHub secrets** — that was the actual lesson, and it survived the platform change intact.

Related earlier fix same session: the Maps key was empty in prod because `gcloud run deploy --source` never forwards `--build-arg` to a Dockerfile build — fixed via `cloudbuild.yaml` + split deploy workflow (PR #1087, merged+deployed+verified).
