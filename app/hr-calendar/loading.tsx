import { AppShell } from "@/components/layout/app-shell";
import { PageLoadingState } from "@/components/ui/loading-state";

export default function Loading() {
  return (
    <AppShell>
      <PageLoadingState title="Loading HR calendar" />
    </AppShell>
  );
}
