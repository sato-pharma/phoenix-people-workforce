import { AlertTriangle, MessageSquareReply } from "lucide-react";
import { redirect } from "next/navigation";

import { AdminInsightChip } from "@/components/admin/admin-design-system";
import { adminChipDepthClassName, adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { RecruitmentPageHeader } from "@/components/recruitment/recruitment-premium";
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
    const heading = "WhatsApp replies unavailable";
    return (
      <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
        {header()}
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
            <p className="text-sm font-black text-amber-950">{heading}</p>
            <p className="mt-1 break-words text-[13px] leading-5 text-amber-900">{message}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
      {header(report.windowDays)}
      <WhatsAppRepliesView report={report} />
    </div>
  );
}

/** The page's one header, on the record and on its error state alike. */
function header(windowDays?: number) {
  return (
    <RecruitmentPageHeader
      badges={
        <>
          <AdminInsightChip tone="orange">Last {windowDays ?? 30} days</AdminInsightChip>
          <AdminInsightChip tone="slate">Read-only record</AdminInsightChip>
        </>
      }
      description="Every message the recruitment line sent over the last 30 days, with the exact text the person received and whether it reached WhatsApp."
      icon={<MessageSquareReply aria-hidden="true" className="h-3.5 w-3.5" />}
      title="WhatsApp Replies"
    />
  );
}
