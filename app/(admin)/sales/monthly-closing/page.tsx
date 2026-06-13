import { redirect } from "next/navigation";

import { MonthlyClosingWorkspace } from "@/components/sales/monthly-closing-workspace";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
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

  // The admin upload + publish workspace is reserved for the admin account (Super Admin /
  // system scope). Sales managers and product managers consume the published closing through
  // the employee-portal Monthly Closing tab instead. Server-side enforcement.
  if (access.role !== "Super Admin" && access.scope !== "system") {
    redirect(resolveLandingPathForRole(access.role));
  }

  let initialMatrix: MonthlyClosingMatrix | null = null;
  let initialError: string | null = null;

  try {
    await assertPermission(access, "sales", "import");
    initialMatrix = await loadMonthlyClosing();
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Failed to load Monthly Closing.";
  }

  return <MonthlyClosingWorkspace canPublish initialError={initialError} initialMatrix={initialMatrix} />;
}
