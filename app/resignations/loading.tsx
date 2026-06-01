import { AppShellLoading } from "@/components/layout/app-shell-loading";
import { Card } from "@/components/ui/card";
import { LoadingSpinner } from "@/components/ui/loading-state";
import { adminPanelClassName } from "@/components/admin/admin-design-system";

export default function Loading() {
  return (
    <AppShellLoading>
      <Card className={`${adminPanelClassName} flex min-h-48 items-center justify-center p-6`}>
        <div className="flex items-center gap-3 text-[#475569]">
          <LoadingSpinner className="h-5 w-5" />
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#0F172A]">Resignations</p>
            <p className="text-sm">Loading resignation workflows</p>
          </div>
        </div>
      </Card>
    </AppShellLoading>
  );
}
