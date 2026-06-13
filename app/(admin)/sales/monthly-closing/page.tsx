import { redirect } from "next/navigation";

import { MonthlyClosingWorkspace } from "@/components/sales/monthly-closing-workspace";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { resolveOrganogramLineForEmployee } from "@/lib/reports/organogram";
import {
  loadMonthlyClosing,
  type MonthlyClosingMatrix,
} from "@/lib/sales/monthly-distributor-import";

export const dynamic = "force-dynamic";

export default async function MonthlyClosingPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals/sales");
  }

  const isPmGpm = access.role === "Product Manager" || access.role === "Group Product Manager";

  if (access.role !== "Super Admin" && access.scope !== "system" && !isPmGpm) {
    redirect(resolveLandingPathForRole(access.role));
  }

  let initialMatrix: MonthlyClosingMatrix | null = null;
  let initialError: string | null = null;

  try {
    if (isPmGpm) {
      await assertPermission(access, "sales", "read");
      const lineName = await resolveOrganogramLineForEmployee(access);
      initialMatrix = await loadMonthlyClosing({ line: lineName });
    } else {
      await assertPermission(access, "sales", "import");
      initialMatrix = await loadMonthlyClosing();
    }
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Failed to load Monthly Closing.";
  }

  return <MonthlyClosingWorkspace initialError={initialError} initialMatrix={initialMatrix} />;
}
