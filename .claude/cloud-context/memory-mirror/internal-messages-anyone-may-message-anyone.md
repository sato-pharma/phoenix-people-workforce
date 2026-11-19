---
name: internal-messages-anyone-may-message-anyone
description: "Owner decision 19 Nov 2026 (REC-053) — any active employee may message anyone in Internal Messages; never add a recipient-scope restriction by role, line or department unasked"
metadata:
  node_type: memory
  type: project
  originSessionId: aab98ae6-6a51-4bc2-83ae-97bf3fce152e
  modified: 2026-11-19T01:57:19.787Z
---

**Internal Messages has no recipient scope: any active employee holding `internal_messages:create` may message anyone in the company.** The owner chose "Anyone to anyone" on 19 Nov 2026 (about 04:00 Cairo), when asked about audit recommendation REC-053. He was shown two other options and turned both down: "own line plus managers and HR" and "only managers and HR start conversations".

**Why:** the guards already in place cover the risk: the `internal_messages:create` permission (F-COM-004), per-sender limits per minute and per day, and an audit row on every send. All of them are live on production.

**How to apply:** never build a "who may message whom" restriction, and never report REC-053 as open again. It is closed by his decision. Pinned code: `app/api/messages/route.ts` and `app/api/messages/recipients/route.ts` assert the permission, and the messaging service holds the limits and the audit row. Related: [[enterprise-audit-recommendations-s01]].
