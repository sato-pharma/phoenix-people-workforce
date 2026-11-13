import { Activity, AlertTriangle } from "lucide-react";
import { redirect } from "next/navigation";

import { AdminInsightChip } from "@/components/admin/admin-design-system";
import { adminChipDepthClassName, adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { IntakeHealthView } from "@/components/recruitment/intake-health-view";
import { RecruitmentPageHeader } from "@/components/recruitment/recruitment-premium";
import { WhatsAppConnectLinkPanel } from "@/components/recruitment/whatsapp-connect-link-panel";
import { guardSeatPage } from "@/lib/auth/seat-page-guard";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { canViewInboundIntakeHealth } from "@/lib/recruitment/access";
import {
  getInboundIntakeAnalytics,
  listHeldBackIntakeAttachments,
} from "@/lib/recruitment/inbound/intake-analytics";
import { listDeadLetteredInbound } from "@/lib/recruitment/inbound/intake-queue";

export const dynamic = "force-dynamic";

// Read-mostly inbound-CV intake funnel: volume, per-channel/outcome breakdown, capture rate, and
// the dead-lettered CVs (with a retry action). Gated by canViewInboundIntakeHealth
// (src/lib/recruitment/access.ts): HR Advisory + Super Admin.
//
// This is the alarm on the front door of the whole module: if CVs stop arriving, this page is the
// only thing that says so. Kept deliberately on 2026-08-15 when the three CV tuning tools next to
// it were removed.
export default async function IntakeHealthPage() {
  const access = await resolveAccessContextFromPage();
  guardSeatPage(access, "/recruitment/intake-health");
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals");
  }
  if (!canViewInboundIntakeHealth(access)) {
    redirect("/employee-portals");
  }

  let analytics;
  let deadLetters;
  let heldBack;
  try {
    [analytics, deadLetters, heldBack] = await Promise.all([
      getInboundIntakeAnalytics(30),
      listDeadLetteredInbound(50),
      listHeldBackIntakeAttachments(30),
    ]);
  } catch (error) {
    const message = String((error as { message?: unknown })?.message ?? error);
    return (
      <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
        <IntakeHealthHeader />
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
            <p className="text-sm font-black text-amber-950">Intake health unavailable</p>
            <p className="mt-1 break-words text-[13px] leading-5 text-amber-900">{message}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
      <IntakeHealthHeader deadLettered={deadLetters.length} windowDays={analytics.windowDays} />
      <IntakeHealthView analytics={analytics} deadLetters={deadLetters} heldBack={heldBack} />
      {/* The one-time WhatsApp connect link: Super Admin only, as its route checks on the server. */}
      {access.scope === "system" ? <WhatsAppConnectLinkPanel /> : null}
    </div>
  );
}

/** The page's one header, on the funnel and on its error state alike. Chips only when the read landed. */
function IntakeHealthHeader({ deadLettered, windowDays }: { deadLettered?: number; windowDays?: number }) {
  return (
    <RecruitmentPageHeader
      badges={
        windowDays === undefined ? undefined : (
          <>
            <AdminInsightChip tone="orange">Last {windowDays} days</AdminInsightChip>
            {deadLettered ? (
              <AdminInsightChip tone="slate">
                {deadLettered === 1 ? "1 CV waiting for a retry" : `${deadLettered} CVs waiting for a retry`}
              </AdminInsightChip>
            ) : (
              <AdminInsightChip tone="emerald">Nothing waiting for a retry</AdminInsightChip>
            )}
          </>
        )
      }
      description="How WhatsApp and email CVs are flowing into the pipeline over the last 30 days, and any that could not be processed automatically (retry re-queues them for the worker)."
      icon={<Activity aria-hidden="true" className="h-3.5 w-3.5" />}
      title="Inbound CV Intake Health"
    />
  );
}
