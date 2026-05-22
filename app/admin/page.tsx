import { AlertCircle } from "lucide-react";
import { redirect } from "next/navigation";

import { AdminCommandCenter } from "@/components/admin/admin-command-center";
import { AppShell } from "@/components/layout/app-shell";
import { Card } from "@/components/ui/card";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { getAdminCommandCenterData } from "@/lib/admin/command-center";
import { resolveAccessContextFromPage, resolveViewerIdentityFromPage } from "@/lib/auth/server";
import { getEmployeeDirectory, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { formatHrIdForDisplay } from "@/lib/hr-id";

export const dynamic = "force-dynamic";

export default async function AdminCommandPage() {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals");
  }

  if (!await canAccess(access, "admin", "read") && !await canAccess(access, "overview", "read")) {
    redirect("/employee-portals");
  }

  let data = null;
  let loadError: string | null = null;
  const viewer = await resolveViewerIdentityFromPage(access);
  let viewerEmployee: EmployeeDirectoryRow | null = null;

  try {
    data = await getAdminCommandCenterData(access);
  } catch (error) {
    console.error("Failed to load Admin Command Center:", error);
    loadError = error instanceof Error ? error.message : "Unknown error occurred";
  }

  if (access.hrId) {
    try {
      const normalizedAccessHrId = access.hrId.replace(/[^a-z0-9]/gi, "").toLowerCase();
      const directory = await getEmployeeDirectory();
      viewerEmployee = directory.employees.find(
        (employee) => employee.hrId.replace(/[^a-z0-9]/gi, "").toLowerCase() === normalizedAccessHrId,
      ) ?? null;
    } catch {
      viewerEmployee = null;
    }
  }

  const welcomeProfile = {
    fullName: viewerEmployee?.fullName ?? viewer.displayName,
    hrId: formatHrIdForDisplay(viewerEmployee?.hrId ?? access.hrId),
    managerName: viewerEmployee?.managerName ?? null,
    systemRoleLabel: viewer.roleLabel,
    titleLabel: viewerEmployee?.jobTitle ?? viewerEmployee?.positionTitle ?? viewer.roleLabel,
  };

  return (
    <AppShell navigationMode="admin">
      {data ? (
        <AdminCommandCenter data={data} welcomeProfile={welcomeProfile} />
      ) : (
        <div className="p-8">
          <Card className="mx-auto max-w-2xl border-rose-100 bg-rose-50 p-6">
            <div className="mb-4 flex items-center gap-3 text-rose-600">
              <AlertCircle className="h-6 w-6" />
              <h2 className="text-lg font-bold">Command Center Error</h2>
            </div>
            <p className="mb-4 text-sm text-rose-700">
              There was a problem loading operational data from Supabase. Please ensure your database views and tables are correctly configured.
            </p>
            <div className="rounded-lg border border-rose-200 bg-white/50 p-3">
              <p className="break-all font-mono text-xs text-rose-800">
                {loadError ?? "Unknown error occurred"}
              </p>
            </div>
          </Card>
        </div>
      )}
    </AppShell>
  );
}
