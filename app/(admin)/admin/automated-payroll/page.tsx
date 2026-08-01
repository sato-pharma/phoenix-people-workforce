import { redirect } from "next/navigation";

import { AutomatedPayrollWizard } from "@/components/automated-payroll/automated-payroll-wizard";
import {
  isAutomatedPayrollHrActor,
  isAutomatedPayrollPublisher,
} from "@/lib/automated-payroll/permissions";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { currentCairoDateParts } from "@/lib/i18n/format";

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

  // Cairo, not the runtime clock: this is a server component on a UTC runtime and these seed the
  // wizard's `useState`, which is what POSTs the run. In the first 2-3 hours of a Cairo month the
  // raw clock still reads the previous month, so the whole company's salary run would be created
  // under the wrong period key.
  const { year, month } = currentCairoDateParts();
  return (
    <AutomatedPayrollWizard
      initialMonth={month}
      initialYear={year}
      isPublisher={isAutomatedPayrollPublisher(access)}
    />
  );
}
