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

  if (!await canAccess(access, "admin", "read")) {
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
    console.error("Failed to load Audit Logs:", error);
    loadError = error instanceof Error
      ? error.message
      : typeof error === "object" && error && "message" in error
        ? String(error.message)
        : "Unknown error occurred";
  }

  return (
    <AppShell navigationMode="admin">
      <div className="min-h-[calc(100vh-7rem)] rounded-[32px] border border-[#E2E8F0] bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.12),transparent_30%),linear-gradient(180deg,#F8FAFC_0%,#EEF3F8_100%)] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] sm:p-6 xl:p-8">
        <div className="space-y-7">
          <div className="relative overflow-hidden rounded-3xl border border-[#D8E0EA] bg-white/95 p-7 shadow-[0_20px_54px_rgba(15,23,42,0.09)]">
            <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-orange-200/35 blur-3xl" />
            <div className="pointer-events-none absolute bottom-0 left-12 h-28 w-28 rounded-full bg-slate-200/45 blur-2xl" />
            <div className="relative flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-orange-200 bg-orange-50 px-3 py-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-orange-500" />
                  <span className="text-[11px] font-black uppercase tracking-[0.18em] text-orange-600">Governance trail</span>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#0B0B0B] text-orange-400 shadow-[0_14px_30px_rgba(15,23,42,0.22)]">
                    <ScrollText className="h-5 w-5" />
                  </div>
                  <div>
                    <h1 className="text-3xl font-black tracking-tight text-slate-950">Audit Logs</h1>
                    <p className="mt-1 text-sm text-slate-500">Full system audit trail, searchable and exportable.</p>
                  </div>
                </div>
              </div>
              {data && (
                <div className="rounded-2xl border border-[#E2E8F0] bg-[#F8FAFC] px-4 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">
                  <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">Total events</p>
                  <p className="mt-1 text-2xl font-black text-slate-950">{data.total.toLocaleString("en-US")}</p>
                </div>
              )}
            </div>
          </div>

          {data ? (
            <AuditLogViewer initialData={data} initialFilters={filters} />
          ) : (
            <Card className="border-rose-200 bg-[linear-gradient(135deg,#FFF1F2_0%,#FFFFFF_100%)] p-6 shadow-[0_16px_36px_rgba(244,63,94,0.10)]">
              <div className="mb-4 flex items-center gap-3 text-rose-600">
                <AlertCircle className="h-6 w-6" />
                <h2 className="text-lg font-bold">Failed to Load Audit Logs</h2>
              </div>
              <div className="rounded-lg border border-rose-200 bg-white/70 p-3">
                <p className="break-all font-mono text-xs text-rose-800">{loadError ?? "Unknown error"}</p>
              </div>
            </Card>
          )}
        </div>
      </div>
    </AppShell>
  );
}
