import { AppShellLoading } from "@/components/layout/app-shell-loading";
import { PageLoadingState } from "@/components/ui/loading-state";

export default function EmployeesLoading() {
  return (
    <AppShellLoading>
      <PageLoadingState title="Loading employee management" />
    </AppShellLoading>
  );
}
