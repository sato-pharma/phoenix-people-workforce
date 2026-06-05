import { redirect } from "next/navigation";

import { ExecutiveReportWorkspace } from "@/components/sales/executive-report-workspace";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { loadExecutiveReport, toExecutiveView, type ExecutiveReportView } from "@/lib/sales/executive-report";

export const dynamic = "force-dynamic";

export default async function ExecutiveReportPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals/sales");
  }

  // Admin-only (Super Admin / system scope). Server-side enforcement — sidebar visibility is UX.
  if (access.role !== "Super Admin" && access.scope !== "system") {
    redirect(resolveLandingPathForRole(access.role));
  }

  let initialView: ExecutiveReportView | null = null;
  let initialError: string | null = null;

  try {
    await assertPermission(access, "sales", "import");
    initialView = toExecutiveView(await loadExecutiveReport(null)); // default: all-time
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Failed to load Executive Report.";
  }

  return <ExecutiveReportWorkspace initialError={initialError} initialView={initialView} />;
}
