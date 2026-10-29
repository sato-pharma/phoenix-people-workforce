---
name: optional-means-still-asked-never-hidden
description: "When the owner says \"make this question optional\", the question stays on screen, open, labelled optional — never folded behind a button or removed"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 3485f661-9251-42b8-94c6-98c759517b22
  modified: 2026-10-29T17:46:29.551Z
---

"Make this question optional" means the question is still asked, visible and open, with a blank answer allowed. It does not mean fold it away behind an "Add a reason" button.

**Why:** On 2026-10-29, PR 6659 made the out-of-plan reason optional, but it also started the visit form's reason box closed behind "Add a reason". He said: "You totally removed it. I told you I wanted to be optional. You removed it." PR 6662 put the box back open.

**How to apply:** When making a field optional, change only the validation and the label ("(optional)"). Leave its visibility, position and default-open state exactly as they were.
