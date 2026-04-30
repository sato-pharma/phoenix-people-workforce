import { AppShell } from "@/components/layout/app-shell";
import { PageLoadingState } from "@/components/ui/loading-state";

export default function EmployeeImportLoading() {
  return (
    <AppShell>
      <PageLoadingState title="Loading employee import" />
    </AppShell>
  );
}
