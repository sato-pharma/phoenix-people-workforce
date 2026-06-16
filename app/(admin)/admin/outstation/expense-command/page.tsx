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
  await assertOutstationAdminAccess(access, "read");
  const canApprove = await canAccess(access, "outstation", "approve");

  const resolved = await searchParams;
  const tabParam = firstString(resolved.tab);
  const active: "intelligence" | "queue" = tabParam === "queue" && canApprove ? "queue" : "intelligence";

  if (active === "queue") {
    const requestIdParam = firstString(resolved.requestId);
    const initialRequestId = requestIdParam ? Number(requestIdParam) : null;
    const requests: OutstationExpenseRequest[] = await listOutstationRequests({
      includeCarEvidenceSignedUrls: true,
    });
    return (
      <ExpenseCommandTabs active="queue" canApprove={canApprove}>
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
