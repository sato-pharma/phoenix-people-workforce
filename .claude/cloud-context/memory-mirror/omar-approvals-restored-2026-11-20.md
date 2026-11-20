---
name: omar-approvals-restored-2026-11-20
description: 20 Nov 2026 — 76 Place checks validations the owner had approved and that were later rejected were taken back to approved; pre-image schema phoenix_crm_backup_20261120
metadata:
  node_type: memory
  type: project
  originSessionId: 93ef71f1-e0cb-4542-814d-c955400e553f
  modified: 2026-11-20T01:37:30.691Z
---

Owner, 20 Nov 2026 ~03:30 Cairo: "in place checks every historical approval by omar gawish make it validated again".

Done the same night through `restoreValidation` (the app's own "Approve it after all", actor B-10, no note): 76 reviews he had approved and that were later rejected (73 by him on 19 Nov, 1 by the SFE Manager A-2 on 25 Oct, 2 older) are approved again; all 76 places active, all 76 customers validated, `reopened_at` cleared, visit distances re-stamped, line twins shared, the "not confirmed" bells withdrawn.

Pre-image: production schema `phoenix_crm_backup_20261120` — `omar_restore_targets`, `omar_restore_reviews`, `omar_restore_places`, `omar_restore_customers`. Never drop it without his word (production has no PITR).

Then, on his "Restore all 5": the 5 buildings refused afterwards (Tabarak, Harmal, El Nour, El Hosary 12, El Hoda hospital) restored through `restoreSharedPlace`, all 7 approved customers inside validated; Sameh Abdelmawgoud's review row set to approved by hand to match (pre-image tables `omar_restore_building*` in the same schema). The 3 doctors rejected as `short_name` on 10 Nov were first kept sent back, then on his "Validate the 3" restored too (pre-image `omar_restore_short_name*`). End state: all 505 places he ever approved have a validated customer; 0 left waiting to be validated. Already fine, untouched: 7 retired places whose customer is validated on another place; 2 dropped and 5 outside customers whose approved place still stands.

Related: [[crm-validation-audit-owner-decisions-2026-11-14]]
