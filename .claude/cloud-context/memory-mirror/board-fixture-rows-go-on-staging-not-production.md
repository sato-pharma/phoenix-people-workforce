---
name: board-fixture-rows-go-on-staging-not-production
description: A browser walk-through of merged code belongs on the Hetzner preview box, which reads STAGING Supabase — so its fixture rows and photos go on staging, never production.
metadata:
  type: project
---

`/home/phx/secure/.env.local` on the preview box is the **staging** project
(`cifwmndunmlxjhyjugxa`, `APP_ENV=staging`, `PHOENIX_ENABLE_DEV_AUTH_HEADERS=true`), so a fixture
built on production is invisible there. Build it on staging, and sign in through
`/api/dev-auth?role=…&hrId=…` — the staging Railway app answers that route **404**, the box does not.

Staging's organogram mirrors production (`SEAT-AIF-REP-D13` is B-7, Menoufia 2 / Delta (1)) and
`employees` holds B-10, B-7 and B-12, so the same seat and HR ids work. `phoenix_crm_customers`
has no FK on `own_contact_crm_id` — any spare bigint will do. The archived
`.env.local.staging-20260921` in the repo root still carries a working staging service-role key for
uploads. Related: [[a-crm-photo-fixture-path-must-be-slot-shaped]],
[[the-preview-mirrors-loose-objects-must-be-group-readable]].
