---
name: staging-employees-hold-demo-identities-2026-11-03
description: "Until 3 Nov 2026, 198 of staging's employees held demo identities; on his choice they were replaced with real data by sync-staging-hr --apply, and the pre-images are in staging_reconcile_backup_20261103"
metadata:
  node_type: memory
  type: project
  originSessionId: 8f2404f8-1938-4b37-9d1f-a6bb8117cb7f
  modified: 2026-11-03T09:28:35.068Z
---

On 3 Nov 2026 the staging HR drift check reached its database step on GitHub for what looks like the first time and reported 91 inserts and 320 updates. 198 of staging's 199 employees used `demo.satopharma.com`, last changed 29 Sep 2026.

Asked by multiple choice, the owner chose "Copy real data". The same day `node scripts/sync-staging-hr.mjs --apply` replaced them and all 12 tables re-diffed clean. Pre-images are in the staging schema `staging_reconcile_backup_20261103`.

Before the sync could run, `20261031210456_coaching_skills_survey.sql` was applied to staging with `scripts/apply-sql-file.mjs`. Production had it with no ledger row, and staging had none of it.

**Why:** the drift check can only read clean when the identities match, so staging now holds real names, national IDs and contacts again. Its email safety rests on `PHOENIX_EMAIL_FORCE_TESTING`, read on before the sync. Keeps [[staging-is-now-mock-data-not-a-production-mirror]] true: never hand staging to a third party.

**How to apply:** a drift alert after this is a real HR change, and refreshing staging stays a person's decision (owner, 2026-09-29). A column on production but not staging makes `--apply` stop and roll back; apply the missing migration to staging first.
