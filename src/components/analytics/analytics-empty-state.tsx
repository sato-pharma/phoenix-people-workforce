import { BarChart3 } from "lucide-react";

type Props = {
  message?: string;
};

export function AnalyticsEmptyState({ message = "No data available for the selected filters." }: Props) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 border border-dashed border-border bg-muted/20 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center border border-border bg-card">
        <BarChart3 className="h-5 w-5 text-muted-foreground/50" />
      </div>
      <p className="max-w-xs text-sm text-muted-foreground">{message}</p>
    </div>
  );
}
