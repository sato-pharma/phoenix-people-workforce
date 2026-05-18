import { AlertCircle } from "lucide-react";
import { redirect } from "next/navigation";

import { MonitoringDashboard } from "@/components/admin/monitoring-dashboard";
import { AppShell } from "@/components/layout/app-shell";
import { Card } from "@/components/ui/card";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getOperationalMonitoringStats, type MonitoringEventSort } from "@/lib/operations/events";

export const dynamic = "force-dynamic";

type QueryValue = string | string[] | undefined;

function normalizeQueryValue(value: QueryValue) {
  return Array.isArray(value) ? value[0] : value;
}

function normalizePage(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function normalizeMonitoringSort(value: string | undefined): MonitoringEventSort {
  return value === "oldest" ? "oldest" : "newest";
}

export default async function AdminMonitoringPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, QueryValue>>;
}) {
  const access = await resolveAccessContextFromPage();

  if (!await canAccess(access, "admin", "read") && !await canAccess(access, "overview", "read")) {
    redirect("/employee-portals");
  }
  const query = await searchParams;
  const entityType = normalizeQueryValue(query.type);
  const page = normalizePage(normalizeQueryValue(query.page), 1);
  const pageSize = normalizePage(normalizeQueryValue(query.pageSize), 20);
  const search = normalizeQueryValue(query.search);
  const sort = normalizeMonitoringSort(normalizeQueryValue(query.sort));

  let stats = null;
  let loadError: string | null = null;

  try {
    stats = await getOperationalMonitoringStats({
      entityType: entityType,
      page,
      pageSize,
      search,
      sort,
    });
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
