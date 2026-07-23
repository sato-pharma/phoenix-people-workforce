import { redirect } from "next/navigation";

import { FingerprintDeductionsReview } from "@/components/attendance/fingerprint-deductions-review";
import { isAutomatedPayrollHrActor } from "@/lib/automated-payroll/permissions";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function FingerprintDeductionsPage() {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals");
  }

  // Same HR authority (Super Admin) gate as Automated Payroll — enforced again on the API route.
  if (!isAutomatedPayrollHrActor(access)) {
    redirect("/admin");
  }

  const now = new Date();
  return <FingerprintDeductionsReview initialMonth={now.getMonth() + 1} initialYear={now.getFullYear()} />;
}
