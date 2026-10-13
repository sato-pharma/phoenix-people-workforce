---
name: a-railway-variable-is-reverted-by-its-github-secret
description: "A production Railway variable fixed by hand comes BACK to its old value, because scripts/sync-railway-production-secrets.mjs pushes the GitHub SECRET of the same name over it — and `gh variable get` answers \"not found\" for a name `gh secret list` shows, so a session checks the wrong store and concludes GitHub holds nothing."
metadata:
  node_type: memory
  type: project
  originSessionId: 8e267189-5ccf-4057-b0e0-7aaccceded73
  modified: 2026-10-13T11:45:09.356Z
---

`HR_NOTIFICATION_EMAILS` was fixed on Railway production on 2026-09-13 (the suppressed
`phoenix@satopharma.com` replaced with a real employee address, because a shared mailbox matches
no employee row and the directory gate drops it). Read live on **2026-10-13** it was back to
`phoenix@satopharma.com`, so HR's admin copies were reaching nobody again.

**The mechanism is the secret sync, not a person.** `scripts/sync-railway-production-secrets.mjs`
line 116 maps `HR_NOTIFICATION_EMAILS` → the GitHub secret of the same name (created 2026-08-08,
before the fix), and `.github/workflows/sync-railway-production-secrets.yml` pushes it to Railway.
Every run of that workflow restores the pre-fix value. `.railway/railway.ts` is NOT the culprit —
it lists the key as `preserve()`.

**So a hand fix to a synced variable is temporary unless the GitHub secret is updated in the same
turn.** Both were set on 2026-10-13: the Railway variable (`--skip-deploys`, so no ungated deploy)
and the secret.

🔴 **And check the right store before concluding GitHub holds nothing:** `gh variable get
HR_NOTIFICATION_EMAILS` answers `variable ... was not found` while `gh secret list` shows it with a
timestamp. A secret's value cannot be read back at all — the proof of an update is its `updated_at`
moving, never its content.

**A variable change does not reach the running container.** `--skip-deploys` leaves the new value
waiting for the next deploy; without that flag Railway starts a deploy of its own that is NOT held
by the Wait-for-CI gate (see [[the-deploy-is-gated-on-ci-and-fails-by-not-shipping]]), which is why
the flag is the right default while any commit's CI is in flight.

Related: [[hr-notification-emails-dropped-cloudrun]], [[email-spam-dns-root-cause]].
