import { redirect } from "next/navigation";

import { AutomatedPayrollWizard } from "@/components/automated-payroll/automated-payroll-wizard";
import {
  isAutomatedPayrollHrActor,
  isAutomatedPayrollPublisher,
} from "@/lib/automated-payroll/permissions";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function AutomatedPayrollPage() {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals");
  }

  // HR authority (Super Admin) only — enforced on every API route too.
  if (!isAutomatedPayrollHrActor(access)) {
    redirect("/admin");
  }

  const now = new Date();
  return (
    <AutomatedPayrollWizard
      initialMonth={now.getMonth() + 1}
      initialYear={now.getFullYear()}
      isPublisher={isAutomatedPayrollPublisher(access)}
    />
  );
}
