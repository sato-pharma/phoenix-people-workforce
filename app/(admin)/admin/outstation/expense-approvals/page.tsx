import { ExpenseApprovalsWorkspace } from "@/components/outstation/expense-approvals-workspace";
import { canAccessSystemAdministratorWorkspace } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function OutstationExpenseApprovalsPage() {
  const access = await resolveAccessContextFromPage();
  if (!canAccessSystemAdministratorWorkspace(access)) {
    redirect("/admin/access");
  }

  return <ExpenseApprovalsWorkspace />;
}
