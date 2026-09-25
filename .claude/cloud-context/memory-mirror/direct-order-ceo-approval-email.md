---
name: direct-order-ceo-approval-email
description: "On final CEO approval of a direct order, a polished details-table email fires To ahmed.elmaraghy@satopharma.com, CC the CEO + system admin. Built + PR #1179"
metadata: 
  node_type: memory
  type: project
  originSessionId: e809b225-37bc-4db0-b13f-de36f150f936
---

Owner asked (2026-07-19): when the CEO gives FINAL approval to a direct order, email ALL order details in a polished table **To** ahmed.elmaraghy@satopharma.com, **CC** the CEO + system admin.

**BUILT — PR #1179** (branch codex/direct-order-ceo-email off origin/main, worktree _wt-direct-orders). Files: NEW `src/lib/direct-orders/approved-email.ts` (`sendDirectOrderApprovedEmail(row)` — branded premium table via `renderPhoenixEmailHtml`+`renderPhoenixEmailText` from `@/emails/phoenix-email-layout`, sent via `sendPhoenixEmail` from `@/lib/email/send-phoenix-email`; CC = active CEO+Super Admin work_emails resolved live like `resolveCeoSuperAdminRecipients` in sos-report-delivery.ts). `service.ts`: `dispatchDirectOrderApprovedEmail(requestId)` (resolves the fully-denormalized row via `getDirectOrderReport(systemAccessContext,{requestId})` — added a lean optional requestId filter to it — + calls the sender). Decision route `app/api/direct-orders/[id]/decision/route.ts`: fires it via **Next.js `after()`** on `result.status==='approved' && !result.reversalOfRequestId`.

**KEY LESSON — email must NOT block the approval.** First impl awaited `sendPhoenixEmail` inline in `decideDirectOrder`; because EMAIL_NOTIFICATIONS_ENABLED is truthy via `.env.local` even on the local staging dev server, the synchronous Resend call blocked the decision response → the e2e CEO-approval step **timed out**. Fix: dispatch via `after()` from the ROUTE (runs after the response, Node runtime) — non-blocking, best-effort. Pattern to reuse for any bespoke email off a mutation.

**GOTCHAS:** (1) `tests/email-notifications.test.ts` has a `directSendPhoenixEmailFiles()` **governance allowlist** — any new file calling sendPhoenixEmail must be registered there or the test fails. (2) `sendPhoenixEmail` ALWAYS CCs omar.anwar@satopharma.com (hardcoded) + is TESTING-mode-redirected outside production (isForceTestingDelivery) + gated on EMAIL_NOTIFICATIONS_ENABLED — so the real send to Ahmed+CC only happens in PROD. (3) requester_hr_id stored LOWERCASE. Verified on staging via e2e (DM b-154→RM PD-0001→NSM A-12→CEO AA approves fast, email deferred; CC resolver=2 emails: 1 CEO+1 SA). Additive, no migration. **PR #1179 MERGED 2026-07-19 06:02 UTC** (owner "merge"; GraphQL "base branch modified" race → retry succeeded) → auto-deploy; **real send to Ahmed+CC begins once deployed to prod**. Worktree awaits CLEAN. See [[direct-orders-phase-c-injection-design]], [[email-template-unification]].
