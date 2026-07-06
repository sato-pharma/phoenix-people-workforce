import { redirect } from "next/navigation";

import { InsuranceWageImport } from "@/components/payroll/copilot/insurance-wage-import";
import {
  canAccessSystemAdministratorWorkspace,
  resolveNavigationMode,
} from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function InsuranceWagesPage() {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals");
  }
  const allowed = access.role === "CEO" || canAccessSystemAdministratorWorkspace(access);
  if (!allowed) {
    redirect("/admin");
  }

  return <InsuranceWageImport />;
}
