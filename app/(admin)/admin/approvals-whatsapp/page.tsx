import { redirect } from "next/navigation";

import { ApprovalsWhatsAppScreen } from "@/components/approvals-whatsapp/approvals-whatsapp-screen";
import { canUseApprovalsWhatsApp } from "@/lib/approvals-whatsapp/rules";
import { APPROVALS_LINE_DISPLAY_NUMBER, ApprovalsWhatsAppNotInstalledError, listApprovalsConversations } from "@/lib/approvals-whatsapp/store";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { logError } from "@/lib/observability/log";
import { whatsAppApprovalsLine } from "@/lib/whatsapp-inbox/lines";

export const dynamic = "force-dynamic";

// Approvals WhatsApp — the third company number, +20 10 40631155, read and answered inside Phoenix.
//
// The owner's answers of 19 Nov 2026: replies on this number are kept, on "my screen only", and the screen is "Super
// Admin only". The gate is a role check, not a permission — no grant in the matrix is that narrow — and every route
// under /api/admin/approvals-whatsapp repeats it (`approvalsWhatsAppForbidden`). This redirect is not the boundary.
export default async function ApprovalsWhatsAppPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals");
  if (!canUseApprovalsWhatsApp(access)) redirect("/admin");

  const line = whatsAppApprovalsLine();

  let initial: Awaited<ReturnType<typeof listApprovalsConversations>>;
  try {
    initial = await listApprovalsConversations({});
  } catch (error) {
    // An error state, never an empty list: "nobody has written" and "the chats could not be read" must not look alike.
    const notInstalled = error instanceof ApprovalsWhatsAppNotInstalledError;
    if (!notInstalled) {
      logError("Approvals WhatsApp page could not list conversations", { error, labels: { event: "approvals_whatsapp_page_list_failed" } });
    }
    return (
      <div className="flex flex-col gap-3">
        <h1 className="text-[20px] font-black text-phx-ink">Approvals WhatsApp</h1>
        <div className="border border-phx-warn-line bg-phx-warn-bg px-4 py-3" role="alert">
          <p className="text-[13px] font-bold text-phx-ink">Approvals WhatsApp is not available</p>
          <p className="mt-1 break-words text-[13px] leading-5 text-phx-ink-2">
            {notInstalled
              ? "Its database tables are not installed here yet, so no chats, lists or reports can be shown."
              : "The chats could not be read just now. Refresh the page to try again."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {line ? null : (
        <div className="border border-phx-warn-line bg-phx-warn-bg px-4 py-3" role="status">
          <p className="break-words text-[13px] leading-5 text-phx-ink-2">
            The approvals number is not set up on this server, so chats already kept can be read but nothing can be sent.
          </p>
        </div>
      )}
      <ApprovalsWhatsAppScreen
        displayNumber={APPROVALS_LINE_DISPLAY_NUMBER}
        initialConversations={initial.conversations}
        initialTotalUnread={initial.totalUnread}
        lineId={line?.phoneNumberId ?? ""}
      />
    </div>
  );
}
