import { Card } from "@/components/ui/card";
import { adminPanelClassName } from "@/components/admin/admin-design-system";
import { LoadingSpinner } from "@/components/ui/loading-state";

export default function Loading() {
  return (
    <Card className={`${adminPanelClassName} flex min-h-64 items-center justify-center p-6`}>
      <div className="flex items-center gap-3 text-phx-ink-2">
        <LoadingSpinner className="h-5 w-5" />
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-phx-ink">Probation Period</p>
          <p className="text-sm">Loading probation data</p>
        </div>
      </div>
    </Card>
  );
}
