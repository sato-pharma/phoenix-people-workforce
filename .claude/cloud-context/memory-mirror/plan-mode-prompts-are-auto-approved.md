---
name: plan-mode-prompts-are-auto-approved
description: In plan mode every permission prompt is answered by a PermissionRequest hook — never ask him to approve tool calls one by one there.
metadata:
  node_type: memory
  type: feedback
  originSessionId: 60e0d800-a646-46d7-ba05-bfab6ed7f7ec
  modified: 2026-10-25T22:23:49.418Z
---

In plan mode nothing waits on his click: `~/.claude/hooks/plan-mode-auto-approve.mjs`, registered under BOTH `PreToolUse` (matcher `*`, answers before any prompt surface exists, the desktop app's own included) and `PermissionRequest` (the backstop) in `~/.claude/settings.json` (2026-10-26; PreToolUse added on his "fix the plan-mode prompts again"), allows every prompt in plan mode, denies (never prompts) a file edit outside `~/.claude/plans`, and leaves only the plan approval (ExitPlanMode) and his answers (AskUserQuestion) to him. Log: `~/.claude/logs/plan-mode-auto-approve.log`.

**Why:** owner, 2026-10-26 — "hilarious number of prompts" in plan mode; "they are auto approved, don't tell me approve on them one by one". `useAutoModeDuringPlan: true` was already set and did not stop them.

**How to apply:** never remove or narrow this hook, never tell him to approve tool calls in plan mode; if prompts return in plan mode, read the log first (no lines = the hook is not firing).
