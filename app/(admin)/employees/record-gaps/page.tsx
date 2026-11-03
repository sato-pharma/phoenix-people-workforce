import { redirect } from "next/navigation";
import { Suspense } from "react";

import { EmployeeRecordGaps } from "@/components/employees/employee-record-gaps";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { canAccess, resolveNavigationMode, type AccessContext } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { employeeDirectoryErrorMessage } from "@/lib/employees/employee-directory";
import { getEmployeeRecordGaps } from "@/lib/employees/record-gaps";
import type { EmployeeRecordGapsData } from "@/lib/employees/record-gaps-logic";
import { hrFormsAccessFor } from "@/lib/hiring-pack/paper-access";

export const dynamic = "force-dynamic";

export default async function EmployeeRecordGapsPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals");
  }

  if (!(await canAccess(access, "employees", "read"))) {
    redirect("/employee-portals");
  }

  return (
    <Suspense
      fallback={<AppRouteLoadingState description="Checking each active employee's bank and insurance details." title="Loading Record Gaps" />}
    >
      <EmployeeRecordGapsContent access={access} />
    </Suspense>
  );
}

async function EmployeeRecordGapsContent({ access }: { access: AccessContext }) {
  let data: EmployeeRecordGapsData | null = null;
  let error: string | null = null;

  try {
    data = await getEmployeeRecordGaps(access);
  } catch (caught) {
    error = employeeDirectoryErrorMessage(caught);
  }

  // Each link is offered only to a seat its own page admits: a reader has no form to save, and the bank
  // letter's page turns away a paper-grant seat.
  const [canEdit, forms] = await Promise.all([canAccess(access, "employees", "update"), hrFormsAccessFor(access)]);

  return <EmployeeRecordGaps canEdit={canEdit} canOpenBankLetter={forms.canRead && forms.paperScope === null} data={data} error={error} />;
}
