---
name: answers-scale-to-the-task-simple-question-simple-answer
description: "Reply length scales with task size - answer first, no repeated facts, no plan or alternatives unless asked, stop investigating once evidence is enough; the Next step line, MCQ rule and safety checks stay."
metadata:
  node_type: memory
  type: feedback
  originSessionId: a4522148-cf2e-4572-8b87-ea8d8d1ae801
  modified: 2026-10-23T13:15:04.883Z
---

Owner, 23 Oct 2026 (self-audit request): Claude's answers were "much longer than necessary" and it "overthinks simple requests". A simple question gets a simple answer; a complex implementation keeps the detail needed to execute it correctly.

**Why:** long replies cost him reading time, and his own prompts are short imperatives.

🔴 **This note is about REPLY LENGTH ONLY — never about memory, context or effort.** The 23 Oct audit first blamed the effort level and the auto-loaded context, and acting on that reading (effort to medium, compaction window to 200,000) is what made the sessions "cold" and the memory fade; he reversed both the same day. The measured causes of the real slowness were the app's leaked terminal shells and renderer growth per session switch, neither of which memory touches. See [[never-lower-the-compact-window-or-the-default-effort]].

**How to apply:**
- Answer the actual question first; no intro or closing recap; do not restate what is already established.
- No plan, no list of alternatives, no status narration unless the task needs one. One recommendation, not a survey.
- Stop investigating once the evidence is sufficient; batch look-arounds into one step.
- Never trade away validation, security checks or the proof-before-claim rule to save tokens.
- Unchanged by this: the opening `**Next step:**` line, MCQ-only questions, names not codes, Cairo times.
