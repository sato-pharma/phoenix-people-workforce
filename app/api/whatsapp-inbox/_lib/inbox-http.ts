// Shared helpers for the WhatsApp Inbox API routes (not a route — underscore folder).
//
// Every inbox route calls `requireRecruitmentAccess(request, "recruitment", "update")` itself and then
// `inboxForbidden(access)`. The first is the session and matrix gate the access-registry test reads in
// each route's own source; the second is the one that matters here — the Super Admin and, since
// 2026-10-08, the Talent Acquisition seat (canUseWhatsAppInbox), and nobody else.

import type { AccessContext } from "@/lib/auth/permissions";
import { recruitmentApiError, recruitmentProblem } from "@/app/api/recruitment/_lib/http";
import { canUseWhatsAppInbox } from "@/lib/whatsapp-inbox/access";
import { WhatsAppInboxSendError } from "@/lib/whatsapp-inbox/send";
import { WhatsAppInboxInputError, WhatsAppInboxNotFoundError } from "@/lib/whatsapp-inbox/store";

export function inboxForbidden(access: AccessContext) {
  if (canUseWhatsAppInbox(access)) return null;
  return recruitmentProblem("The WhatsApp Inbox is not open to your role.", 403);
}

export function inboxApiError(error: unknown, fallback: string) {
  if (error instanceof WhatsAppInboxNotFoundError) return recruitmentProblem(error.message, 404);
  if (error instanceof WhatsAppInboxInputError) return recruitmentProblem(error.message, 400);
  if (error instanceof WhatsAppInboxSendError) return recruitmentProblem(error.message, error.status);
  return recruitmentApiError(error, fallback);
}

export function inboxActor(access: AccessContext): string | null {
  return access.loginId ?? access.hrId ?? null;
}
