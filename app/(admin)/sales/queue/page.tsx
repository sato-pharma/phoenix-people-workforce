import { SalesQueue } from "@/components/sales/sales-queue";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { listSalesQueue } from "@/lib/sales/service";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function SalesQueuePage() {
  const accessContext = await resolveAuthenticatedPageAccess();
  if (resolveNavigationMode(accessContext) === "employee-portal") {
    redirect("/employee-portals/source-of-sales");
  }
  let initialData = null;
  let initialError: string | null = null;

  try {
    await assertPermission(accessContext, "sales", "read");
    initialData = await listSalesQueue(accessContext);
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Failed to load sales queue.";
  }

  return (
    <SalesQueue
      initialData={initialData}
      initialError={initialError}
    />
  );
}
