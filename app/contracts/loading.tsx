import { AppShellLoading } from "@/components/layout/app-shell-loading";
import { PageLoadingState } from "@/components/ui/loading-state";

export default function Loading() {
  return (
    <AppShellLoading>
      <PageLoadingState title="Loading contract renewals" />
    </AppShellLoading>
  );
}
