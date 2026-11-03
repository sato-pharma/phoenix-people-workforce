---
name: staging-employees-hold-demo-identities-2026-11-03
description: "Live read on 3 Nov 2026: 198 of staging's 199 employees have demo.satopharma.com addresses, last changed 29 Sep, so sync-staging-hr --apply would overwrite them with real names and national IDs"
metadata:
  node_type: memory
  type: project
  originSessionId: 8f2404f8-1938-4b37-9d1f-a6bb8117cb7f
  modified: 2026-11-03T09:23:35.749Z
---

On 3 Nov 2026 the staging HR drift check reached its database step on GitHub for what looks like the first time. It reported 91 inserts and 320 updates. For `public.employees`, 199 rows differ in `national_id`, and 198 in `full_name`, `name_ar`, `crm_username`, `work_email` and `mobile_number`.

Live read on staging: 198 of 199 employees use `demo.satopharma.com`, last changed 29 Sep 2026 16:28 UTC. Production has one domain, `satopharma.com`. This contradicts `staging-is-now-mock-data-not-a-production-mirror`, which says staging holds real names since the 29 Aug clone.

**Why:** `node scripts/sync-staging-hr.mjs --apply` copies every column, so it would replace those demo identities with real names, national IDs and contacts. The check can never read clean while they stay, so its Telegram alert repeats daily at 07:00 Cairo.

**How to apply:** never run `--apply` on the alert's own "Fix:" line without his decision on the identities. Re-read staging before relying on either note. Related: [[staging-is-now-mock-data-not-a-production-mirror]].
