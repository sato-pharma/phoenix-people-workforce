import { AlertCircle, Bug } from "lucide-react";
import { redirect } from "next/navigation";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { ErrorMonitorViewer } from "@/components/admin/error-monitor-viewer";
import { Card } from "@/components/ui/card";
import { getErrorEvents, type ErrorEventFilter } from "@/lib/error-monitor/service";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function ErrorMonitorPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const access = await resolveAccessContextFromPage();

  if (!await canAccess(access, "admin", "read")) {
    redirect("/employee-portals");
  }

  const params = await searchParams;
  const filters: ErrorEventFilter = {
    dateFrom: params.dateFrom ?? null,
    dateTo: params.dateTo ?? null,
    hrId: params.hrId ?? null,
    moduleKey: params.module ?? null,
    page: Number(params.page ?? "1"),
    pageSize: 50,
    source: params.source === "server" || params.source === "client" ? params.source : null,
  };

  let data = null;
  let loadError: string | null = null;

  try {
    data = await getErrorEvents(filters);
  } catch (error) {
    console.error("Failed to load Error Monitor:", error);
    loadError = error instanceof Error
      ? error.message
      : typeof error === "object" && error && "message" in error
        ? String(error.message)
        : "Unknown error occurred";
  }

  return (
    <div className="min-h-[calc(100vh-7rem)] rounded-[32px] border border-[#E2E8F0] bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.12),transparent_30%),linear-gradient(180deg,#F8FAFC_0%,#EEF3F8_100%)] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] sm:p-6 xl:p-8">
        <div className="space-y-7">
          <AdminPageHero
            description="Unhandled crashes across the app, tagged by HR ID and module. Self-hosted — no vendor, no trial expiry."
            eyebrow="Crash monitor"
            icon={<Bug className="h-3.5 w-3.5" />}
            title="Error Monitor"
            aside={
              data ? (
                <div className="border border-white/10 bg-white/10 px-4 py-3 backdrop-blur">
                  <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">Total events</p>
                  <p className="mt-1 text-2xl font-black text-white">{data.total.toLocaleString("en-US")}</p>
                </div>
              ) : undefined
            }
          />

          {data ? (
            <ErrorMonitorViewer initialData={data} initialFilters={filters} />
          ) : (
            <Card className="border-rose-200 bg-[linear-gradient(135deg,#FFF1F2_0%,#FFFFFF_100%)] p-6 shadow-[0_16px_36px_rgba(244,63,94,0.10)]">
              <div className="mb-4 flex items-center gap-3 text-rose-600">
                <AlertCircle className="h-6 w-6" />
                <h2 className="text-lg font-bold">Failed to Load Error Monitor</h2>
              </div>
              <div className="rounded-lg border border-rose-200 bg-white/70 p-3">
                <p className="break-all font-mono text-xs text-rose-800">{loadError ?? "Unknown error"}</p>
              </div>
            </Card>
          )}
        </div>
    </div>
  );
}
