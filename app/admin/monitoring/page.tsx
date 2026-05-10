import { AlertCircle } from "lucide-react";
import { redirect } from "next/navigation";

import { MonitoringDashboard } from "@/components/admin/monitoring-dashboard";
import { AppShell } from "@/components/layout/app-shell";
import { Card } from "@/components/ui/card";
import { getAdminMonitoringStats } from "@/lib/admin/service";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function AdminMonitoringPage() {
  const access = await resolveAccessContextFromPage();

  if (!await canAccess(access, "admin", "read") && !await canAccess(access, "overview", "read")) {
    redirect("/employee-portals");
  }

  let stats = null;
  let loadError: string | null = null;

  try {
    stats = await getAdminMonitoringStats();
  } catch (error) {
    console.error("Failed to load Monitoring Dashboard:", error);
    loadError = error instanceof Error ? error.message : "Unknown error occurred";
  }

  return (
    <AppShell navigationMode="admin">
      {stats ? (
        <MonitoringDashboard stats={stats} />
      ) : (
        <Card className="border-rose-100 bg-rose-50 p-6">
          <div className="mb-4 flex items-center gap-3 text-rose-600">
            <AlertCircle className="h-6 w-6" />
            <h2 className="text-lg font-bold">Monitoring Error</h2>
          </div>
          <p className="mb-4 text-sm text-rose-700">
            There was a problem loading admin monitoring data from Supabase.
          </p>
          <div className="rounded-lg border border-rose-200 bg-white/50 p-3">
            <p className="break-all font-mono text-xs text-rose-800">
              {loadError ?? "Unknown error occurred"}
            </p>
          </div>
        </Card>
      )}
    </AppShell>
  );
}
