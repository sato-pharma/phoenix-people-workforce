import { ExpenseCommandDashboard } from "@/components/outstation/expense-command-dashboard";
import { parseExpenseFiltersFromRecord } from "@/components/outstation/expense-shared/formatters";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { assertOutstationAdminAccess } from "@/lib/outstation/admin-access";
import { getOutstationExpenseCommandData } from "@/lib/outstation/expense-command";
import type { OutstationExpenseCommandData } from "@/lib/outstation/expense-command-types";

export const dynamic = "force-dynamic";

export default async function ExpenseCommandPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await resolveAccessContextFromPage();
  await assertOutstationAdminAccess(access, "read");

  const resolved = await searchParams;
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
    <ExpenseCommandDashboard
      initialData={data}
      initialError={initialError}
      initialFilters={filters}
      mapsBrowserKey={process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY ?? ""}
      variant="admin"
    />
  );
}
