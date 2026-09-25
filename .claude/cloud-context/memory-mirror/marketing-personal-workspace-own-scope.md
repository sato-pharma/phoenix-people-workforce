---
name: marketing-personal-workspace-own-scope
description: "Personal Marketing Requests workspace (Drafts/In-approval/Returned/Approved) is scoped to the viewer's OWN submissions for company-wide oversight roles; don't re-broaden."
metadata: 
  node_type: memory
  type: project
  originSessionId: 2b5128fc-66a8-47ad-9150-21eadfe4e702
---

LOCKED behavior decision — **SHIPPED to production 2026-06-21** via PR #411 (squash `db7a342f` on `main`). Originally commit 9639bc91.

The personal **Marketing Requests** portal/admin workspace (`MarketingRequestDraftWorkspace` → `/api/marketing-requests/drafts` → `getMarketingRequestDraftWorkspace` in `src/lib/marketing-requests/service.ts`) is a *my own requests* surface. Its **Drafts, In-approval, Returned, and Approved** lists must show only the requests the viewer personally submitted (`requesterHrId === access.hrId`) for the company-wide oversight roles in `companyMarketingRoles` (Marketing Manager, SFE Manager, CEO, Finance Manager, Financial Advisor, Super Admin) plus `scope === "system"`.

**Why:** those roles get `true` from `canSeeMarketingHierarchyRecord` for EVERY request, which flooded the Marketing Manager's personal Tracking/Approved tabs with the whole company. Owner asked it be cleaned to own-requests only.

**How to apply:** the narrowing helper is `narrowToOwnRequests` in `getMarketingRequestDraftWorkspace`. Line/team roles (DM/RM/NSM/PM/GPM) are intentionally NOT scoped here — they keep their bounded subtree view. Company-wide monitoring lives on Control / Inbox / ROI Tracking (separate queries), not the personal workspace. Don't re-broaden these four lists. Verified live: Marketing Manager@B-74 saw only B-74's 17 in-approval + 10 approved (vs 95/100 company-wide). Related: [[marketing-request-readonly-lockdown]].
