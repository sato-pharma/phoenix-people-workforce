import { AppShell } from "@/components/layout/app-shell";
import { DataHealthDashboard } from "@/components/admin/data-health-dashboard";
import { getDataHealthStats } from "@/lib/admin/service";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { redirect } from "next/navigation";
import { Card } from "@/components/ui/card";
import { AlertCircle } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function DataHealthPage() {
  const access = await resolveAccessContextFromPage();
  
  // Verify permissions: admin:read or overview:read
  const [hasAdminRead, hasOverviewRead] = await Promise.all([
    canAccess(access, "admin", "read"),
    canAccess(access, "overview", "read"),
  ]);

  if (!hasAdminRead && !hasOverviewRead) {
    redirect("/employee-portals");
  }

  let stats = null;
  let loadError: string | null = null;

  try {
    stats = await getDataHealthStats();
  } catch (error) {
    console.error("Failed to load Data Health Dashboard:", error);
    loadError = error instanceof Error ? error.message : "Unknown error occurred";
  }

  return (
    <AppShell navigationMode="admin">
      {stats ? (
        <DataHealthDashboard stats={stats} />
      ) : (
        <div className="p-8">
          <Card className="mx-auto max-w-2xl border-rose-100 bg-rose-50 p-6">
            <div className="mb-4 flex items-center gap-3 text-rose-600">
              <AlertCircle className="h-6 w-6" />
              <h2 className="text-lg font-bold">Data Governance Error</h2>
            </div>
            <p className="mb-4 text-sm text-rose-700">
              There was a problem loading the data health audit from Supabase. Please ensure your governance views are correctly configured.
            </p>
            <div className="rounded-lg border border-rose-200 bg-white/50 p-3">
              <p className="break-all text-xs font-mono text-rose-800">
                {loadError ?? "Unknown error occurred"}
              </p>
            </div>
          </Card>
        </div>
      )}
    </AppShell>
  );
}
