---
name: phx1-system-admin-identity
description: "B-10, PHX-1 and login admin-HR are ONE person (Omar Anwar Gawish, HR Manager + system super admin); code-level alias group, no data merge."
metadata: 
  node_type: memory
  type: project
  originSessionId: 5078f037-7589-4474-ae79-3f07aa3bb776
  modified: 2026-07-25T07:54:43.112Z
---

**Owner ruling 2026-07-25 (supersedes the 2026-06-30 "different person" note):** `B-10`
(Omar Anwar Ibrahim Ahmed Gawish, Hr Manager, omar.anwar@satopharma.com) and the system
super-admin identity `PHX-1` (login `admin-HR`, plus the legacy `ADMIN-HR` employees row)
are **the same physical person**. Never treat them as two actors again.

Production shape (verified 2026-07-25): two active Super Admin logins — `admin-HR` → hr_id
`PHX-1`, and `B-10` → hr_id `B-10`. Three employees rows: `B-10` (real, payroll-eligible),
plus `PHX-1` and `ADMIN-HR` (both "Phoenix System Administrator", payroll_eligible=false,
organogram_visible=false, no work_email).

**Chosen model: code-level alias group, NO data rewrite.** Owner rejected merging history.
`src/lib/auth/identity-aliases.ts` is the single primitive (`sharedIdentityKeys`,
`canonicalPersonHrId`, `isSamePerson`, `sharedIdentityDisplayName`). It is deliberately NOT
wired into `canonicalHrIdKey`/`hrIdsMatch` in `src/lib/hr-id.ts` — doing so would make the
PHX-1 employee row unreachable and would rewrite persisted HR_IDs. Historic rows keep their
original HR_ID so audit still shows which console acted.

**Why:** the concept was re-implemented per module and the copies disagreed — probation
exempted PHX-1 from the notification cap while mailing B-10, so the same human was both
exempt and capped.

**How to apply:** any new "is this the same person / should this account get X" rule imports
the primitive. Never add another hardcoded `["B-10", "PHX-1"]` list.

Related: [[approvals-history-table-name-bug]], [[project-leave-excuse-approver-model]],
[[probation-email-recipients-and-templates-rule]].
