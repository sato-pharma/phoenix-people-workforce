---
name: marketing-request-readonly-lockdown
description: "Marketing requests are read-only for ALL approvers once submitted; only the original submitter edits, and only after a return-for-edit. Shipped PR"
metadata: 
  node_type: memory
  type: project
  originSessionId: bbbd2639-f05e-49de-997c-16e5f7dd16f9
---

LOCKED business rule (owner was emphatic): the moment an employee submits a
marketing request it is **read-only for everyone in the approval chain**
(DM → NSM → SFE → Marketing → CEO → Finance). No approver at any stage may
edit the request content. The ONLY edit path is the **original submitter**, and
**only** when a manager has returned it for edit. Drafts (pre-submit) are still
the employee's to edit.

**Why:** owner reported managers could freely edit a submitted request — totally unacceptable.

**How to apply:**
- Backend `resubmitReturnedMarketingRequest` is the ONLY content-edit endpoint; it
  already enforces requester-ownership + `status === "returned"`. Keep it that way.
- UI must gate edit controls on **`returnedToMe`** (returned requests the viewer
  personally submitted: `returned.filter(req => normalizeHrId(req.requesterHrId) === normalizeHrId(access.hrId))`),
  NOT on `returned` (which is hierarchy-visible = monitoring only). `canSeeMarketingRequest`
  is visibility, never edit authority.
- Never re-add an "Open full request" link from the approver decision screen into the
  editable employee-portal workspace (`marketing-request-decision-confirmation.tsx`).

Shipped 2026-06-19 as **PR #339** (squash `ee70b995`) — an ISOLATED branch off `main`
(5 files, +24/-14, no migration), deployed + smoke-green on phoenix-workforce.vercel.app.
The rest of `codex/work-from-production` then merged as **PR #340** (`fefa105a`): offer/outstation
"Financial Advisor executes" governance `7ae70ca1`, SFE-validate-only/Finance-step-off
(migration 20260621130000 — APPLIED to prod), sentry next-config, @openai/agents+zod deps.
#340 had a marketing-file conflict with #339; it was resolved on-branch (`eef0d741`
Merge origin/main, keep coaching scoreTable token) and merged — main has NO conflict
markers, the read-only fix stayed intact, validate CI green, prod deploy READY. All
recent marketing/sales/coaching migrations are already applied to prod (MCP-applied,
versions reconciled).

Related: [[marketing-email-editable-tokens]], [[marketing-approver-hrid-casing-fk]].
