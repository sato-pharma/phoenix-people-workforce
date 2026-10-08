// The WhatsApp Inbox — who may open it. Owner decision, 2026-09-15: the Super Admin only. Widened
// by the owner himself on 2026-10-08 to the Talent Acquisition seat (HR Resourcing): asked in chat
// whether his 2026-09-15 ruling should hold for her, he answered "Open all four", this among them.
//
// These are private conversations with applicants, interns and employees on the company's two
// numbers, and replying from them speaks for the company. No permission-matrix grant widens this: the
// check is the role itself, so adding `recruitment:update` to another role cannot open the inbox.

import type { AccessContext } from "@/lib/auth/permissions";

export const WHATSAPP_INBOX_PATH = "/recruitment/whatsapp-inbox";

export function canUseWhatsAppInbox(access: Pick<AccessContext, "role" | "source"> | null | undefined): boolean {
  if (!access || access.source === "guest") return false;
  return access.role === "Super Admin" || access.role === "HR Resourcing";
}
