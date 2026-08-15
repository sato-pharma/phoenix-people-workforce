import { redirect } from "next/navigation";

import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { IntakeHealthView } from "@/components/recruitment/intake-health-view";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canViewInboundIntakeHealth } from "@/lib/recruitment/access";
import {
  getInboundIntakeAnalytics,
  listHeldBackIntakeAttachments,
} from "@/lib/recruitment/inbound/intake-analytics";
import { listDeadLetteredInbound } from "@/lib/recruitment/inbound/intake-queue";

export const dynamic = "force-dynamic";

// Portal mirror of app/(admin)/recruitment/intake-health/page.tsx. Talent Acquisition works out of
// the employee portal, not the admin shell, so without this twin the page is unreachable for the
// one role that owns it.
//
// This one mattered most of the six hub tools, which is why it survived the 2026-08-15 cull: the
// page carries the RETRY action for dead-lettered inbound CVs, and a dead letter is a real
// candidate who applied and silently never entered the pipeline. POST /api/recruitment/intake/retry
// asserts recruitment:update, which the role already holds, so the grant was there the whole time
// and only the page was out of reach.
export default async function EmployeePortalIntakeHealthPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/recruitment/intake-health");
  }
  if (!canViewInboundIntakeHealth(access)) {
    return (
      <EmployeePortalEmptyState
        message="Inbound intake health is available to Talent Acquisition and Super Admin only."
        title="Intake Health Unavailable"
      />
    );
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
    return <EmployeePortalEmptyState message={message} title="Intake Health Unavailable" />;
  }

  return (
    <EmployeePortalPageShell
      badge="Talent Acquisition"
      description="How WhatsApp and email CVs are flowing into the pipeline over the last 30 days, and any that could not be processed automatically — retry re-queues them for the worker."
      errorBoundaryTitle="Intake health unavailable"
      title="Inbound CV Intake Health"
    >
      <IntakeHealthView analytics={analytics} deadLetters={deadLetters} heldBack={heldBack} />
    </EmployeePortalPageShell>
  );
}
