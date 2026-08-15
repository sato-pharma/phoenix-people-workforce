import { redirect } from "next/navigation";

import { IntakeHealthView } from "@/components/recruitment/intake-health-view";
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
// the dead-lettered CVs (with a retry action). Talent Acquisition + Super Admin.
//
// This is the alarm on the front door of the whole module: if CVs stop arriving, this page is the
// only thing that says so. Kept deliberately on 2026-08-15 when the three CV tuning tools next to
// it were removed.
export default async function IntakeHealthPage() {
  const access = await resolveAccessContextFromPage();
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
      <div className="mx-auto max-w-3xl p-6">
        <h1 className="text-lg font-semibold text-slate-900">Intake health unavailable</h1>
        <p className="mt-2 text-sm text-slate-600">{message}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      <div className="mb-4">
        <h1 className="text-lg font-semibold text-slate-900">Inbound CV Intake Health</h1>
        <p className="text-sm text-slate-500">
          How WhatsApp + email CVs are flowing into the pipeline over the last 30 days, and any that could not be
          processed automatically (retry re-queues them for the worker).
        </p>
      </div>
      <IntakeHealthView analytics={analytics} deadLetters={deadLetters} heldBack={heldBack} />
    </div>
  );
}
