---
name: test-crm-rows-on-production-are-his-own-persona-feature
description: CRM rows with `is_test` on production are not a leak to be plugged — ten active `is_test_persona` accounts mirror real employees by design, so refusing test writes on production would break all ten.
metadata:
  type: project
---

"Test fixtures are being written to production" looks like a defect and is not one: it is his own feature from 2026-09-27.

- **Ten active `app_auth_users.is_test_persona` accounts exist on production**, each mirroring a real employee: TEST-HH → B-158 Hassan (created 3 Oct 16:41 Cairo), TEST-AYA → B-7, TEST-AA → B-143, plus TEST-DF, TEST-MS, TEST-RAGAA, TEST-RD, TEST-NH, TEST-SM, TEST-MO.
- **A test persona's session becomes the mirrored person's `hrId`**, which is why a test visit's `entered_by_hr_id` reads a real HR id like `B-158` and looks like a real rep's capture. Plugging test writes on production would break all ten accounts.
- **A test persona is the only writer of test CRM rows** — the Super Admin can no longer enter a rep's visit at all (`superAdminHasNoFieldWrite`), so neither a script nor an admin produced them.
- `capture_source: 'server'` on such a row is set by `phoenix_crm_save_visit` itself when a slot's photo time was stale. It is not a script's fingerprint, and reading it as one sent a session hunting the wrong mechanism.
- Clearing the rows is a separate job with its own shape: [[removing-crm-test-rows-needs-parent-id-deletes]]. It empties the personas' worlds and leaves the accounts working.
