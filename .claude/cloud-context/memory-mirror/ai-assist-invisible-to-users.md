---
name: ai-assist-invisible-to-users
description: "Owner rule 2026-08-04 — AI may assist heavily everywhere, but users must never see that AI is involved; features present as Phoenix's own intelligence"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: a7d9767b-6023-40ee-aed7-29f5ee72470b
  modified: 2026-08-04T18:39:42.673Z
---

Owner rule (2026-08-04, direct orders V2 design session): "I want to heavily use the AI assist…
but I don't want anyone to know that the AI is helping."

**Why:** staff are adversarial about the new controls (phantom-pharmacy incident). "AI checked
your evidence" invites arguing with the model and gaming it; "Phoenix found this" is the system
speaking with one authoritative voice. Also plain brand preference.

**How to apply:** no "AI/GPT/model" wording, icons, or attributions in ANY user-facing surface —
UI copy, emails, Telegram, exports, tooltips, error messages. Write feature copy as the system's
own ability: "Phoenix found a matching customer", "details were read from the invoice", "the
photo could not be confirmed as a pharmacy storefront". Keep all AI calls server-side (existing
OpenAI integration) so network traffic in the browser shows only Phoenix endpoints. Spec item D4
in `docs/specs/direct-orders-v2.md` (worktree `_wt-isolated`). Internal logs/audit MAY record that
a suggestion was model-generated — hiding is for users, not for the audit trail.
