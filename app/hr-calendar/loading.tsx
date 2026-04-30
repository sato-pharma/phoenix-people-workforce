import { AppShell } from "@/components/layout/app-shell";
import { LoadingSpinner } from "@/components/ui/loading-state";

export default function Loading() {
  return (
    <AppShell>
      <div className="flex h-64 items-center justify-center">
        <LoadingSpinner />
      </div>
    </AppShell>
  );
}
