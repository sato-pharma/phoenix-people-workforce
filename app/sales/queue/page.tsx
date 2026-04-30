import { AppShell } from "@/components/layout/app-shell";
import { SalesQueue } from "@/components/sales/sales-queue";
import { listSalesQueue } from "@/lib/sales/service";

export const dynamic = "force-dynamic";

export default async function SalesQueuePage() {
  let initialData = null;
  let initialError: string | null = null;

  try {
    initialData = await listSalesQueue();
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Failed to load sales queue.";
  }

  return (
    <AppShell>
      <SalesQueue
        initialData={initialData}
        initialError={initialError}
      />
    </AppShell>
  );
}
