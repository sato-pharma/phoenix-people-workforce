import { AlertCircle, ScrollText } from "lucide-react";
import { redirect } from "next/navigation";

import { AuditLogViewer } from "@/components/admin/audit-log-viewer";
import { AppShell } from "@/components/layout/app-shell";
import { Card } from "@/components/ui/card";
import { getAuditLogs, type AuditLogFilter } from "@/lib/admin/audit";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function AdminLogsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const access = await resolveAccessContextFromPage();

  if (!canAccess(access, "admin", "read") && !canAccess(access, "audit_admin", "read")) {
    redirect("/employee-portals");
  }

  const params = await searchParams;
  const filters: AuditLogFilter = {
    actor: params.actor ?? null,
    action: params.action ?? null,
    entityType: params.entityType ?? null,
    dateFrom: params.dateFrom ?? null,
    dateTo: params.dateTo ?? null,
    page: Number(params.page ?? "1"),
    pageSize: 50,
  };

  let data = null;
  let loadError: string | null = null;

  try {
    data = await getAuditLogs(filters);
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Unknown error occurred";
  }

  return (
    <AppShell navigationMode="admin">
      <div className="space-y-5">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#F97316]/10">
            <ScrollText className="h-5 w-5 text-[#F97316]" />
          </div>
          <div>
            <h1 className="text-sm font-black uppercase tracking-[0.12em] text-[#0F172A]">Audit Logs</h1>
            <p className="text-xs text-[#64748B]">Full system audit trail — searchable, filterable, exportable</p>
          </div>
        </div>

        {data ? (
          <AuditLogViewer initialData={data} initialFilters={filters} />
        ) : (
          <Card className="border-rose-100 bg-rose-50 p-6">
            <div className="mb-4 flex items-center gap-3 text-rose-600">
              <AlertCircle className="h-6 w-6" />
              <h2 className="text-lg font-bold">Failed to Load Audit Logs</h2>
            </div>
            <div className="rounded-lg border border-rose-200 bg-white/50 p-3">
              <p className="break-all font-mono text-xs text-rose-800">{loadError ?? "Unknown error"}</p>
            </div>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
