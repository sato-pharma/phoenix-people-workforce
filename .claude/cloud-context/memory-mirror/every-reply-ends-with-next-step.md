---
name: every-reply-ends-with-next-step
description: "Owner requires EVERY reply to end with a single recommended next step — enforced by the user-level UserPromptSubmit hook, and since 2026-08-13 also printed on the status bar under his input box"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: c8217a8f-ead4-4534-8079-481b0e017f4f
  modified: 2026-08-13T00:41:12.097Z
---

Every reply must end with a final line beginning `**Next step:**` giving **one** specific,
actionable recommendation — never a menu of options. If nothing is pending, say that plainly on
the same line.

**Why:** the owner runs many parallel streams on a saturated machine and does not want to spend
attention deciding what to do next; they want to be led. This is the same underlying need as
[[user-overwhelmed-needs-lead-and-automate]] and [[owner-heavy-parallel-workload-reduce-friction]],
generalized from the sales-consolidation work to every reply. Requested 2026-08-01: "i want at the
very end of each message claude tell me the recommended next step every single reply".

**How to apply:**
- Enforced mechanically by rule 3 of the `additionalContext` string in the **user-level**
  `UserPromptSubmit` hook (`~/.claude/settings.json`), so it fires on every prompt in every
  project — not just this repo. Memory alone cannot guarantee a per-reply behavior.
- That hook command is a **single-quoted bash `echo`**. Never put an apostrophe or an unescaped
  double quote in the text or the hook silently breaks and ALL the task rules stop arriving.
  Verify after editing by running the command directly and confirming it prints parseable JSON.
- Recommend the highest-value action, not the easiest one. When the honest answer is that the
  work is finished, say so rather than inventing filler.
- **The line is machine-read as of 2026-08-13, so the format is now a contract.** He asked for the
  recommendation to appear on the bar he types at, so a `Stop` hook
  (`~/.claude/hooks/next-step-capture.mjs`) parses it out of the finished reply and
  `~/.claude/hooks/statusline.mjs` prints it as a second status row, directly above the input box.
  The matcher is case-insensitive `next step` + `:` and takes the **last** match in the reply.
  Deviate from `**Next step:** …` as the closing line and the bar shows an orange
  "none given - ask for one" nudge instead. Full detail in the `next-step` skill
  (`~/.claude/skills/next-step/SKILL.md`).
- Hooks are captured at session start, so a change to the `Stop` entry needs a session restart
  before it fires; the `statusLine` command itself is re-read on each render.
