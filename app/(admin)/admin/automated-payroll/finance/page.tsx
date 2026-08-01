import { redirect } from "next/navigation";

import { FinanceDownloadPanel } from "@/components/automated-payroll/finance-download-panel";
import { isAutomatedPayrollFinanceActor } from "@/lib/automated-payroll/permissions";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { currentCairoDateParts } from "@/lib/i18n/format";

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

  // Cairo, not the runtime clock: this period flows into defaultFabValueDate(), so a UTC-derived
  // month in the first 2-3 hours of a Cairo month stamps the FAB bank transfer file with the
  // previous month's value date.
  const { year, month } = currentCairoDateParts();
  return <FinanceDownloadPanel initialMonth={month} initialYear={year} />;
}
