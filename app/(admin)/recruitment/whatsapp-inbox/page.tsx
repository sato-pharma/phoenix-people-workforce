import { AlertTriangle, MessagesSquare } from "lucide-react";
import { redirect } from "next/navigation";

import { adminChipDepthClassName, adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { RecruitmentPageHeader } from "@/components/recruitment/recruitment-premium";
import { WhatsAppInbox } from "@/components/whatsapp-inbox/whatsapp-inbox";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { canUseWhatsAppInbox } from "@/lib/whatsapp-inbox/access";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { logError } from "@/lib/observability/log";
import { whatsAppInboxLines } from "@/lib/whatsapp-inbox/lines";
import { listInboxConversations } from "@/lib/whatsapp-inbox/store";

export const dynamic = "force-dynamic";

// Both company WhatsApp numbers, read and answered inside Phoenix.
//
// The owner asked on 2026-09-15 to "open the whatsapp 2 accounts inside phoenix and be able to
// interact reply save and send", and answered that only the Super Admin should. The gate below is
// that answer, written as a role check rather than a permission because no grant in the matrix is
// narrow enough: `recruitment:update` reaches every recruiter, and these chats include the HR
// handset's private conversations with employees. Every API route under /api/whatsapp-inbox repeats
// the same check — this page hiding is not the boundary. Since 2026-10-08 that check is
// canUseWhatsAppInbox, which also admits the Talent Acquisition seat at the owner's own answer.
export default async function WhatsAppInboxPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals");
  }
  if (!canUseWhatsAppInbox(access)) redirect("/employee-portals");

  const lines = whatsAppInboxLines().map((line) => ({
    displayNumber: line.displayNumber,
    label: line.label,
    phoneNumberId: line.phoneNumberId,
  }));

  let initial;
  try {
    initial = await listInboxConversations({});
  } catch (error) {
    // An error state, never an empty list: "nobody has written" and "the inbox could not be read"
    // must not look the same.
    // Plain words, not the database's own text. A table that is not there yet answers PGRST205
    // through PostgREST (42P01 through SQL) — the state of any environment the migration has not
    // reached.
    const code = (error as { code?: unknown } | null)?.code;
    const notInstalled = code === "PGRST205" || code === "42P01";
    if (!notInstalled) {
      logError("WhatsApp Inbox page could not list conversations", {
        error,
        labels: { event: "whatsapp_inbox_page_list_failed" },
      });
    }
    const message = notInstalled
      ? "The inbox's database tables are not installed here yet, so no chats can be shown."
      : "The chats could not be read just now. Refresh the page to try again.";
    return (
      <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
        <RecruitmentPageHeader
          description="Both company WhatsApp numbers, read and answered inside Phoenix."
          icon={<MessagesSquare aria-hidden="true" className="h-3.5 w-3.5" />}
          title="WhatsApp Inbox"
        />
        <div
          className={`flex items-start gap-3 border border-amber-200 bg-amber-50 px-4 py-4 ${adminSoftDepthClassName}`}
          role="alert"
        >
          <span
            className={`flex h-9 w-9 flex-none items-center justify-center border border-amber-300 bg-white text-amber-600 ${adminChipDepthClassName}`}
          >
            <AlertTriangle aria-hidden="true" className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-black text-amber-950">WhatsApp Inbox unavailable</p>
            <p className="mt-1 break-words text-[13px] leading-5 text-amber-900">{message}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <WhatsAppInbox
      initialConversations={initial.conversations}
      initialTotalCount={initial.totalCount}
      initialTotalUnread={initial.totalUnread}
      lines={lines}
    />
  );
}
