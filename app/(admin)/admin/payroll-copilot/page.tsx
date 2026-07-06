import { redirect } from "next/navigation";

import { PayrollCopilotWorkbench } from "@/components/payroll/copilot/payroll-copilot-workbench";
import {
  canAccessSystemAdministratorWorkspace,
  resolveNavigationMode,
} from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function PayrollCopilotPage() {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals");
  }

  // Payroll Copilot is CEO + Super Admin only. Server-enforced on every route too.
  const allowed = access.role === "CEO" || canAccessSystemAdministratorWorkspace(access);
  if (!allowed) {
    redirect("/admin");
  }

  return <PayrollCopilotWorkbench />;
}
