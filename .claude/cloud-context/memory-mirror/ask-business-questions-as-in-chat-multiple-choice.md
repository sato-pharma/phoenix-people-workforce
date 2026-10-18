---
name: ask-business-questions-as-in-chat-multiple-choice
description: "GOLDEN RULE (2026-10-18) — EVERY question to the owner is a multiple-choice question via AskUserQuestion, never prose or an 'if you want, I can' offer; XLSX only for long per-item lists"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 8673b905-76f2-41d7-96b2-8cebd20654a1
  modified: 2026-10-18T17:42:08.569Z
---

On 2026-09-13 (CRM phase 6), after four XLSX question sheets, the owner said he could not understand them and to ask "here in the form of MCQ". The in-chat multiple-choice questions (AskUserQuestion, max 4 per call, short options, the recommended option first) worked: he answered them in one pass.

**Why:** long bilingual sheets with context paragraphs overwhelmed him. He answers short choices, and he types the real rule into "Other" when no option fits.

**How to apply:** ask business-fact questions in chat as multiple choice, one idea per question, with a concrete example in the option description. Read his "Other" text carefully, because it often overturns an earlier decision. Reserve XLSX for long per-item lists (for example 40 venues to classify). This supersedes the "XLSX with dropdowns" line in AGENTS.md §4 for ordinary questions.

**Widened 2026-10-18 to a GOLDEN RULE.** After a reply that closed with a "needs your call" paragraph and an "if you want, I can find that order" offer in prose, he said: "put a golden rule that you never ask me in the form of text like this. When you need to ask me, you must ask me in the form of MCQ." It is no longer only business facts: a design choice, a data fix, a scope call and every "do you want me to …" go through `AskUserQuestion` (2–4 short options, recommended first). **Why:** a prose question makes him work out what is being asked and type an answer; a choice is one click. **How to apply:** if no choice is genuinely his, do not ask at all — decide and report. Never end a reply with an open question or an offer in prose. The `Next step:` line quotes the recommended option's words; it is not where a question is asked.

Related: [[recommendation-goes-first-not-last]]
