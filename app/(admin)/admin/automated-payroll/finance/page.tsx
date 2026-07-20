import { redirect } from "next/navigation";

import { FinanceDownloadPanel } from "@/components/automated-payroll/finance-download-panel";
import { isAutomatedPayrollFinanceActor } from "@/lib/automated-payroll/permissions";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function AutomatedPayrollFinancePage() {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals");
  }

  // CEO / Financial Advisor / Finance Manager / Super Admin — read/export only.
  if (!isAutomatedPayrollFinanceActor(access)) {
    redirect("/admin");
  }

  const now = new Date();
  return <FinanceDownloadPanel initialMonth={now.getMonth() + 1} initialYear={now.getFullYear()} />;
}
