import { ExpenseCommandDashboard } from "@/components/outstation/expense-command-dashboard";
import { ExpenseCommandTabs } from "@/components/outstation/expense-command-tabs";
import { parseExpenseFiltersFromRecord } from "@/components/outstation/expense-shared/formatters";
import { OutstationRequestsAdmin } from "@/components/outstation/outstation-requests-admin";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { assertOutstationAdminAccess } from "@/lib/outstation/admin-access";
import { getOutstationExpenseCommandData } from "@/lib/outstation/expense-command";
import type { OutstationExpenseCommandData } from "@/lib/outstation/expense-command-types";
import { listOutstationRequests } from "@/lib/outstation/service";
import type { OutstationExpenseRequest } from "@/lib/outstation/types";

export const dynamic = "force-dynamic";

function firstString(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export default async function ExpenseCommandPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await resolveAccessContextFromPage();
  // Page guard is the weaker "read" so a viewer without approve still sees the
  // dashboard tab. The Queue tab is hidden + its data fetch is skipped for them
  // (defense-in-depth; the API routes already require "approve" to act).
  let canApprove = false;
  try {
    await assertOutstationAdminAccess(access, "read");
    canApprove = await canAccess(access, "outstation", "approve");
  } catch (error) {
    return (
      <div className="rounded-[18px] border border-rose-200 bg-[linear-gradient(180deg,#fff7f7_0%,#ffffff_100%)] p-6 text-center shadow-[0_18px_46px_rgba(15,23,42,0.08)]">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-rose-100 bg-rose-50 text-rose-600 shadow-[0_12px_28px_rgba(244,63,94,0.14)]">
          !
        </div>
        <div className="mx-auto mt-4 max-w-2xl space-y-2">
          <p className="text-[10px] font-black uppercase tracking-[0.22em] text-rose-600">
            Access blocked
          </p>
          <h2 className="text-2xl font-black tracking-tight text-slate-950">
            Outstation expense command unavailable
          </h2>
          <p className="text-sm leading-6 text-slate-600">
            {error instanceof Error
              ? error.message
              : "You do not have access to the outstation expense command workspace right now."}
          </p>
        </div>
      </div>
    );
  }

  const resolved = await searchParams;
  const tabParam = firstString(resolved.tab);
  const active: "intelligence" | "queue" = tabParam === "queue" && canApprove ? "queue" : "intelligence";

  if (active === "queue") {
    const requestIdParam = firstString(resolved.requestId);
    const initialRequestId = requestIdParam ? Number(requestIdParam) : null;
    let requests: OutstationExpenseRequest[] = [];
    let queueError: string | null = null;
    try {
      requests = await listOutstationRequests({
        includeCarEvidenceSignedUrls: true,
      });
    } catch (error) {
      queueError = error instanceof Error ? error.message : "Unable to load queue requests right now.";
    }
    return (
      <ExpenseCommandTabs active="queue" canApprove={canApprove}>
        {queueError ? (
          <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
            {queueError}
          </div>
        ) : null}
        <OutstationRequestsAdmin
          initialRequestId={Number.isFinite(initialRequestId) ? initialRequestId : null}
          requests={requests}
        />
      </ExpenseCommandTabs>
    );
  }

  const filters = parseExpenseFiltersFromRecord(resolved);
  let data: OutstationExpenseCommandData | null = null;
  let initialError: string | null = null;
  try {
    data = await getOutstationExpenseCommandData(access, filters);
  } catch (error) {
    initialError =
      error instanceof Error ? error.message : "Could not load outstation expense intelligence.";
  }

  return (
    <ExpenseCommandTabs active="intelligence" canApprove={canApprove}>
      <ExpenseCommandDashboard
        initialData={data}
        initialError={initialError}
        initialFilters={filters}
        mapsBrowserKey={process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY ?? ""}
        variant="admin"
      />
    </ExpenseCommandTabs>
  );
}
