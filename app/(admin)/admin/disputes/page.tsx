import { redirect } from "next/navigation";
import { Scale } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { DisputeCenterWorkspace } from "@/components/disputes/dispute-center-workspace";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { isDisputeCaseKind, type DisputeCaseKind } from "@/lib/dispute-center/types.ts";

// THE DISPUTE CENTER — every dispute, from all three modules, in one place (owner, 2026-10-09).
//
// Before this, a dispute lived in whichever module raised it: the calendar inbox showed only the
// PENDING ones, the deductions tab showed only lines still on a payslip, and the weekly review
// showed only the week it belonged to. A decided case effectively vanished. His instruction was
// exactly that: "dispute closed dispute open but never disappeared from me or the employee side."
//
// The gate is the same `attendance:read` the routes use; who may read or decide a given CASE is
// settled per case inside the domain helpers, which keep each module's own audience rule.
export const dynamic = "force-dynamic";

export default async function AdminDisputeCenterPage({
  searchParams,
}: {
  searchParams: Promise<{ case?: string; kind?: string }>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "attendance", "read"))) redirect("/employee-portals");

  const params = await searchParams;
  const kind: DisputeCaseKind | null = isDisputeCaseKind(params.kind) ? params.kind : null;

  // The case briefing is Super Admin only — his own answer when asked who should have it ("only
  // me"). The route asserts it again; this only decides whether the panel is drawn.
  const canAssist = access.role === "Super Admin";

  return (
    <div className="space-y-5">
      <AdminPageHero
        description="Every dispute an employee has raised — a calendar day, a deduction, or a flagged day in the weekly attendance review. Open or decided, each one keeps its whole conversation, its pictures and its history. Decide it here, or ask for it to be looked at again."
        eyebrow="Attendance & payroll"
        icon={<Scale className="h-3.5 w-3.5" />}
        title="Dispute Center"
      />
      <DisputeCenterWorkspace
        audience="reviewer"
        canAssist={canAssist}
        initialCaseRef={params.case ?? null}
        initialKind={kind}
      />
    </div>
  );
}
