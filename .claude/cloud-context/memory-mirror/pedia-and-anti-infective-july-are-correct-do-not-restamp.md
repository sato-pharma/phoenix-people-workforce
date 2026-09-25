---
name: pedia-and-anti-infective-july-are-correct-do-not-restamp
description: "Owner ruled 2026-08-10 that the Pedia and Anti-Infective July 2026 closings are correct — they keep the PRE-#2015 Office allocation on purpose and must never be re-stamped to match CNS"
metadata: 
  node_type: memory
  type: project
  originSessionId: cfb1b008-82c7-4a44-b3f1-382f5e0f94a9
  modified: 2026-08-10T19:23:45.383Z
---

**Only CNS July 2026 was re-stamped onto the owner's Office value-share rule** (2026-08-10,
`raw_row->>'restamp' = 'owner-restamp-cns-jul-per-line-2026-08-10'`, 1,925 rows → 3,672 rows,
42,838 units unchanged). Pedia and Anti-Infective July are **LOCKED** and every write attempt that
day bounced off `phx_reject_write_to_locked_closing()`.

When told they could be unlocked and re-stamped the same way, the owner answered plainly:
**"no they are correct."** So the two lines keep the pre-#2015 per-product, region→brick,
unit-weighted Office spread **deliberately**.

**Why:** a future session comparing lines will find CNS on one Office rule and Pedia /
Anti-Infective on another, and the obvious "consistency fix" is exactly the thing he refused. The
lock is not an obstacle to route around — for these two line+period pairs it is the intended state.

**How to apply:** never re-stamp Pedia or Anti-Infective 2026-07, never ask for them to be unlocked
for that purpose, and do not report the difference as drift. Later periods imported through the app
pick up the corrected rule by themselves, so the divergence is bounded to July 2026.

Related: [[owner-office-allocation-rule-value-share]] ·
[[office-brick-share-rpc-has-no-line-filter]] ·
[[cns-2026-08-10-production-changes-applied]]
