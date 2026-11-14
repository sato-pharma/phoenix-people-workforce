---
name: a-railway-variable-is-reverted-by-its-github-secret
description: "CHANGED 14 Nov 2026: a production Railway variable fixed by hand is no longer reverted by the secrets sync — the sync now HOLDS a value that differs from the GitHub secret (nothing written, red run, Telegram) until it is released by name. Still true: update the GitHub SECRET in the same turn, and `gh variable get` answers \"not found\" for a name `gh secret list` shows."
metadata:
  node_type: memory
  type: project
  originSessionId: 8e267189-5ccf-4057-b0e0-7aaccceded73
  modified: 2026-11-14T02:01:05.923Z
---

🔴 **CORRECTED 14 Nov 2026 — the revert described below no longer happens.** Since the guard merged
(squash `c9eb7cf48`, serving production 04:00 Cairo on 14 Nov 2026) the sync lists production first
and plans per name in `scripts/lib/secret-sync-plan.mjs`: a name production lacks is written, an equal
value is left, and a value that DIFFERS is **held** — nothing written, the run ends red (exit 3) and
Telegram names the variable. A held value is released only by name, by hand:
`gh workflow run sync-railway-production-secrets.yml -f overwrite=NAME,NAME`. A push passes no names.
The first guarded run on `main` (43543530841) logged `written=0, unchanged=54, held=0, skipped=22`.

**What that changes in practice.** A hand fix on Railway now SURVIVES a sync, but it turns every
later sync run red until the GitHub secret holds the same value. So the rule "update the GitHub
secret in the same turn" still stands, for a new reason: a red sync run, and GitHub's stale copy
being what a recovery would restore. A ROTATION is GitHub first, then the release command above.
Never restore the unconditional write. Rule and account: `.claude/rules/engineering-railway-cli.md`,
`docs/environment.md`. The history below is kept as the reason the guard exists.

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
