---
name: cv-feedback-lock-removed-backup-tag
description: The CV feedback lock (managers must comment before opening another CV) was REMOVED 2026-09-13 by owner decision; full code backed up at git tag backup/cv-feedback-lock-2026-09-13 for recovery.
metadata: 
  node_type: memory
  type: project
  originSessionId: d3792c51-8cc7-43b6-874d-1e253fedc060
  modified: 2026-09-13T15:07:16.153Z
---

The CV feedback lock ran on production 2026-09-09 → 2026-09-13. It refused a manager every CV until he had commented on the last one he opened. The owner removed it on 2026-09-13 in PR #3819: managers kept flagging that it trapped them, and his own checks agreed. In the same PR, "I will call" (the phone reveal) started marking the CV as seen.

**Why:** the owner asked for a backup so he can bring it back at any time.

**How to apply:**
- Never re-add the lock on your own initiative. `tests/cv-lock-removed-reveal-marks-seen.test.ts` pins it as gone.
- If the owner asks to restore it, start from the tag `backup/cv-feedback-lock-2026-09-13`, which is on origin and points at 3f3dd19 (#3818). The tag message holds the steps. The simplest route is `git revert` of #3819's squash merge.
- Recovery is code only: the lock reads `ats_candidate_views` and comments, and both remain.
