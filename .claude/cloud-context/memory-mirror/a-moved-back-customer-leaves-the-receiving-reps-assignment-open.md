---
name: a-moved-back-customer-leaves-the-receiving-reps-assignment-open
description: "Moving customers to another rep and back again leaves the receiving rep's phoenix_crm assignment rows open, so the reference mint re-adds a pending copy of every one on his list."
metadata:
  node_type: memory
  type: project
  originSessionId: 1108b3d3-a97d-415d-93ec-9a20e45b8e3d
  modified: 2026-11-23T19:17:16.517Z
---

On 23 Nov 2026 a hand-over of vacant areas' lists (Down town, Cairo West, Dokki and others; actor B-10, 17:08–19:07 Cairo) was reverted at 19:16 Cairo on the owner's order. The hourly contact refresh (`crm_contact_master_refresh` pass 5b) had already opened `crm_contact_assignments` rows (source `phoenix_crm`, backdated to the rep's counted_from) for every customer while it sat on the receiving seat. Moving the customer back did not close those rows. At 19:17 Cairo `phoenix_crm_ensure_reference_customers` re-minted a pending "To validate" copy of each doctor on the receiving rep's list. Ali Hassan (Cairo East 1, CNS) got 73 doctors and 24 pharmacies from Down town. In all there were 818 copies on 12 seats and 1,727 open rows across 26 reps.

Cleared 23 Nov 2026 21:20 Cairo. Backups are in `au.bak_20261123_handover_leftover_assignments` and `au.bak_20261123_handover_leftover_copies`. One copy on SEAT-CNS-REP-D26 was already validated and visited, so it was left in place.

**Why:** a revert that counts only the moved rows reports "zero left" while the copies come back a minute later.

**How to apply:** any move back, or any hand-over undo, must also close the receiving rep's `phoenix_crm` assignment rows opened during the stay. Then prove it by running `phoenix_crm_ensure_reference_customers` for each receiving seat and checking it returns 0. Related: [[phoenix-crm-reference-list]]
