import { AppShellLoading } from "@/components/layout/app-shell-loading";
import { PageLoadingState } from "@/components/ui/loading-state";

export default function VacanciesLoading() {
  return (
    <AppShellLoading>
      <PageLoadingState title="Loading vacancies" />
    </AppShellLoading>
  );
}
