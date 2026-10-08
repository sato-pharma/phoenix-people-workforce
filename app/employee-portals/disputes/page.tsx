import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { DisputeCenterWorkspace } from "@/components/disputes/dispute-center-workspace";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { isDisputeCaseKind, type DisputeCaseKind } from "@/lib/dispute-center/types.ts";

// MY DISPUTES — the employee's own half of the Dispute Center.
//
// Self-scoped by construction: every list adapter returns only the caller's own cases unless the
// caller is a reviewer for that module, so this page needs no filter of its own. A decided case
// stays here for ever (owner, 2026-10-09: it must never disappear "from me or the employee side"),
// and the employee can ask for another look rather than reopening it themselves.
export const dynamic = "force-dynamic";

export default async function EmployeeDisputesPage({
  searchParams,
}: {
  searchParams: Promise<{ case?: string; kind?: string }>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "attendance", "read"))) redirect("/employee-portals");
  if (!access.hrId) redirect("/employee-portals");

  const params = await searchParams;
  const kind: DisputeCaseKind | null = isDisputeCaseKind(params.kind) ? params.kind : null;

  return (
    <EmployeePortalPageShell
      description="Everything you have disputed — a day on your calendar, a deduction, or a flagged day in your weekly attendance. Reply, add pictures, and read the decision with the reason for it."
      title="My Disputes"
    >
      <DisputeCenterWorkspace audience="employee" initialCaseRef={params.case ?? null} initialKind={kind} />
    </EmployeePortalPageShell>
  );
}
