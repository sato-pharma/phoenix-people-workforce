import { AppShell } from "@/components/layout/app-shell";
import { PageLoadingState } from "@/components/ui/loading-state";

export default function EmployeesLoading() {
  return (
    <AppShell>
      <PageLoadingState title="Loading employee management" />
    </AppShell>
  );
}
