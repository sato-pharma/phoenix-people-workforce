---
name: b-10-is-the-owner-himself
description: "HR id B-10 (Omar Anwar Ibrahim Ahmed Gawish, HR Section Head) is the OWNER — the person in the chat — and the system's only Super Admin, so never treat a B-10 audit row as a third party to notify or advise him to talk to."
metadata: 
  node_type: memory
  type: user
  originSessionId: ead471da-e91b-42e3-b1bc-2e8d1a030aba
  modified: 2026-09-08T10:41:01.286Z
---

**`B-10` is the owner himself** — Omar Anwar Ibrahim Ahmed Gawish, HR Section Head,
`omar.anwar@satopharma.com`, and the **only** `super_admin` in `user_access_profiles`.

**Why this matters:** his hr_id appears as the actor on approvals all over production —
`deductions_decisions.decided_by`, payroll, marketing — and reads exactly like a colleague's.
On 2026-09-08 I found four wrongly-approved July deductions stamped `decided_by: B-10`, and
twice recommended he "have a word with B-10" before checking who that was; the next step would
have been firing a system notification at him about his own decisions. He confirmed: *"yes b-10
is me."*

**How to apply:** when an audit row names B-10, that is the owner acting, so address him
directly in the reply instead of proposing to contact, notify or escalate to that person. Because
recording a deduction decision requires Super Admin and he is the only one, **every**
`deductions_decisions` row with a non-null `decided_by` is his. Do not read a B-10 approval as
third-party sign-off — there is no second pair of eyes in that flow, which is also why a defect
that reaches the review screen with its contradicting evidence stripped gets approved. Two related
traps: a notification fired from this laptop silently never sends, and every automated email also
mirrors to his Telegram, so a "notice to B-10" would arrive as a ping from himself about himself.

See [[never-approve-for-the-ceo]] for the separate rule about the CEO, who is a different person.
