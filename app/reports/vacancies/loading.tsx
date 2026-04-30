import { AppShell } from "@/components/layout/app-shell";
import { PageLoadingState } from "@/components/ui/loading-state";

export default function VacanciesLoading() {
  return (
    <AppShell>
      <PageLoadingState title="Loading vacancies" />
    </AppShell>
  );
}
