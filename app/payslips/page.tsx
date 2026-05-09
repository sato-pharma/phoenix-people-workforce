import { redirect } from "next/navigation";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function PayslipsCenterPage() {
  const access = await resolveAccessContextFromPage();
  
  // Basic security check
  await assertPermission(access, "payslips", "read");
  
  // This route is the entry point for "Payslips Center" in the sidebar.
  // Regardless of role, this should lead to the personal payslip view (Employee Portal).
  // Admins already have a dedicated "Payroll Dashboard" link in their sidebar for management.
  redirect("/employee-portals/payroll");
}
