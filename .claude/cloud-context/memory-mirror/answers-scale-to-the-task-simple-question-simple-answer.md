---
name: answers-scale-to-the-task-simple-question-simple-answer
description: "Reply length scales with task size - answer first, no repeated facts, no plan or alternatives unless asked, stop investigating once evidence is enough; the Next step line, MCQ rule and safety checks stay."
metadata:
  node_type: memory
  type: feedback
  originSessionId: a4522148-cf2e-4572-8b87-ea8d8d1ae801
  modified: 2026-10-23T10:38:49.930Z
---

Owner, 23 Oct 2026 (self-audit request): Claude's answers were "much longer than necessary" and it "overthinks simple requests". A simple question gets a simple answer; a complex implementation keeps the detail needed to execute it correctly.

**Why:** the slowness he feels is mostly effort level, a 114 KB auto-loaded context and long replies, not a single broken process (audit of 23 Oct 2026, see [[slowness-audits-compare-before-and-after]]).

**How to apply:**
- Answer the actual question first; no intro or closing recap; do not restate what is already established.
- No plan, no list of alternatives, no status narration unless the task needs one. One recommendation, not a survey.
- Stop investigating once the evidence is sufficient; batch look-arounds into one step.
- Never trade away validation, security checks or the proof-before-claim rule to save tokens.
- Unchanged by this: the opening `**Next step:**` line, MCQ-only questions, names not codes, Cairo times.
