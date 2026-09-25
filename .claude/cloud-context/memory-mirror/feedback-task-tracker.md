---
name: feedback-task-tracker
description: "User wants visible task tracking (TaskCreate + TaskUpdate) for every command, every session — permanently enforced via hook"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 3e1471e8-6e0e-47d3-8393-755e7c045675
---

User requires a permanent task tracker on every command.

**Why:** The user wants to always see what steps Claude plans to do, and see each step marked done as it's completed. No silent work.

**How to apply:**
- Before starting ANY task, call `TaskCreate` to list all planned steps.
- Call `TaskUpdate` to mark each step `completed` immediately after finishing it — not in a batch at the end.
- Never skip steps silently.

This is enforced via a `UserPromptSubmit` hook in `~/.claude/settings.json` that injects the reminder into every session automatically.
