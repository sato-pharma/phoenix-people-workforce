---
name: codeql-dismissals-2026-11-27-stand
description: "The owner approved, on 27 Nov 2026, the CodeQL triage of the public repo, which took it from 112 open alerts to 18; never reopen those dismissed alerts"
metadata:
  node_type: memory
  type: project
  originSessionId: 059d84db-9c96-426c-807e-834f091f9cb3
  modified: 2026-11-27T11:34:45.291Z
---

🔴 **OWNER, 27 Nov 2026, about 13:40 Cairo: "keep the 85 CodeQL dismissals".**

The CodeQL triage of `sato-pharma/phoenix-people-workforce` took it from 112 open alerts to 18.
- The triage session dismissed 85: 54 as used in tests and 31 as false positives.
- I dismissed 9 on his "decide the 11 open CodeQL alerts":
  - 6 false positives: 139, 133, 132, 71, 66 and 65.
  - Won't fix: 67 and 64, because the device-management server's protocol needs MD5, and 150, the secrets-copy workflow, which PR 837 then retired.
- PR 836 fixed the rest in code.

What stays open, on his word:
- 16 alerts were expected to close at the scan on Sunday 30 Nov, about 23:30 Cairo.
- The 8 password-hash alerts stay open. His words: "Do not change the password rule."
- Alerts 1 and 2 are in mobile workflows. The mobile app is frozen, so they stay untouched.

**Why:** the dismissals were made without his approval and were flagged as such in the PEH-STATUS-001 report. He has now approved them.

**How to apply:**
- Never reopen or re-triage those dismissed alerts.
- Never "fix" the password hashing; that alert class stays open on his word.
- If anything stays open after the 30 Nov scan, report it to him; never dismiss it yourself.

Related: [[history-purge-planned-2026-11-27]], [[the-repo-is-private-since-2026-11-27]].
