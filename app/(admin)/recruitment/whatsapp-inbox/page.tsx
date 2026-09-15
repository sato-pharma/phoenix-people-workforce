import { redirect } from "next/navigation";

import { WhatsAppInbox } from "@/components/whatsapp-inbox/whatsapp-inbox";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
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
// the same check — this page hiding is not the boundary.
export default async function WhatsAppInboxPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals");
  }
  if (access.role !== "Super Admin") redirect("/employee-portals");

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
    const message = String((error as { message?: unknown })?.message ?? error);
    return (
      <div className="mx-auto max-w-3xl p-6">
        <h1 className="text-[20px] font-black text-phx-ink">WhatsApp Inbox unavailable</h1>
        <p className="mt-2 text-[13px] text-phx-ink-soft">{message}</p>
      </div>
    );
  }

  return (
    <WhatsAppInbox
      initialConversations={initial.conversations}
      initialTotalUnread={initial.totalUnread}
      lines={lines}
    />
  );
}
