import { redirect } from "next/navigation";

import { WhatsAppRepliesView } from "@/components/recruitment/whatsapp-replies-view";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canViewWhatsAppOutboundLog } from "@/lib/recruitment/access";
import { getWhatsAppOutboundReport } from "@/lib/recruitment/inbound/whatsapp-outbound-report";

export const dynamic = "force-dynamic";

// What Phoenix actually SAID to people on WhatsApp — the exact words, the number, and the outcome.
//
// This page exists because on 2026-08-30 the owner asked "show me the reply that went out" and the
// answer had to be reconstructed from whichever source commit was live at that second. The outbound
// log table closed that gap the same night; this is the screen that reads it back, so the question
// is a page he opens rather than a query somebody has to run for him.
//
// Read-only by construction: no route handler, no action, nothing to click. The record is an audit
// trail, and an audit trail with an edit button is a weaker one.
export default async function WhatsAppRepliesPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals");
  }
  if (!canViewWhatsAppOutboundLog(access)) {
    redirect("/employee-portals");
  }

  let report;
  try {
    report = await getWhatsAppOutboundReport(30, 50);
  } catch (error) {
    // Deliberately an error state rather than an empty list. "No replies" and "the query failed"
    // look identical once a reader swallows the error, and telling those two apart is most of what
    // this page is for.
    const message = String((error as { message?: unknown })?.message ?? error);
    return (
      <div className="mx-auto max-w-3xl p-6">
        <h1 className="text-lg font-semibold text-slate-900">WhatsApp replies unavailable</h1>
        <p className="mt-2 text-sm text-slate-600">{message}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      <div className="mb-4">
        <h1 className="text-lg font-semibold text-slate-900">WhatsApp Replies</h1>
        <p className="text-sm text-slate-500">
          Every message the recruitment line sent over the last 30 days, with the exact text the
          person received and whether it reached WhatsApp.
        </p>
      </div>
      <WhatsAppRepliesView report={report} />
    </div>
  );
}
