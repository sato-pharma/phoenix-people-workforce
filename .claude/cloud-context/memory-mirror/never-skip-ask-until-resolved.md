---
name: never-skip-ask-until-resolved
description: "Owner rule — never skip/silently drop anything; ask as many questions as needed (even hundreds) to confirm the best result"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 6ceaecc2-d940-4a0e-9524-7fa7adc6fef0
---

NEVER skip, drop, or silently work around anything when doing a task. If something can't be resolved cleanly, STOP and ASK the user until it's resolved — do not guess, do not leave it incomplete, do not hide it behind a default.

**Why:** the owner cares about correctness and completeness over speed. They explicitly said: "I told you never skip anything, ask me till resolved... ask me as much as you can to confirm the best result even if you're gonna ask me hundreds of questions." A silent skip (e.g. the 152 unlinked pharmacies in the ROI import) is exactly what they do NOT want.

**How to apply:** surface every gap, mismatch, unmatched row, ambiguity, or judgment call. Prefer asking (AskUserQuestion or plain question) over assuming. When a batch operation can't handle some rows, report each one and ask — never `continue`/filter them away. Confirm understanding before AND during the work, not just at the end. Asking many questions is welcomed, not a nuisance. Relates to [[ai-tool-damage-prevention]] (guardian rule), [[user-overwhelmed-needs-lead-and-automate]].
