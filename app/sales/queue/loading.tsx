import { AppShellLoading } from "@/components/layout/app-shell-loading";
import { LoadingSpinner } from "@/components/ui/loading-state";

export default function Loading() {
  return (
    <AppShellLoading>
      <div className="flex h-64 items-center justify-center">
        <LoadingSpinner />
      </div>
    </AppShellLoading>
  );
}
