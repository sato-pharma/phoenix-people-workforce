import { redirect } from "next/navigation";

import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export default async function EmployeeOutstationNewPage() {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }

  if (access.role === "Medical Rep") {
    redirect("/employee-portals/expenses");
  }

  if (access.role === "District Manager" || access.role === "National Sales Manager") {
    redirect("/employee-portals/submit-expense");
  }

  redirect("/employee-portals/expense-dashboard");
}
