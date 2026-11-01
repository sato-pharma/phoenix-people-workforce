---
name: same-name-on-a-seat-does-not-prove-the-same-doctor
description: "The iReports360 copy left 759 same-name pairs between Archive doctors and the rep's own customers; a name never proves one doctor, so they are never merged by name."
metadata:
  node_type: memory
  type: project
  originSessionId: 0b2851ca-8456-43cd-8140-cf3c46b2dd82
  modified: 2026-11-01T09:35:08.788Z
---

Read live on production, 2026-11-01. The first run of the iReports360 history copy left 759 pairs on one seat, same name after spacing is tidied: 7 against a doctor the rep added (29 copied visits) and 752 against a customer with a DIFFERENT old-system contact (680 share a speciality, 674 share speciality and list). 750 Archive rows and 4,517 copied visits sit in them. The count is a floor: spelling and Arabic/English differences are missed.

No link joins any of them: `customer_identity_links` holds 23 rows and 0 tie an old contact to a Phoenix customer.

**Why:** 4,237 names are shared by more than one old contact, so one name is routinely two doctors (أحمد بكري is Urology on one row, Internal Medicine on the other).

**How to apply:** never merge these by name in a repair or a script. A move needs someone to confirm that it is the same doctor. Spacing matters when matching: an exact-text match finds only 164 of the pairs. See [[a-bash-heredoc-can-eat-the-backslash-of-a-sql-regex]].
