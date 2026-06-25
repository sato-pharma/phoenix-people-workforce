import { BarChart3 } from "lucide-react";

type Props = {
  message?: string;
};

export function AnalyticsEmptyState({ message = "No data available for the selected filters." }: Props) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center gap-3">
      <BarChart3 className="h-10 w-10 text-muted-foreground/40" />
      <p className="text-sm text-muted-foreground max-w-xs">{message}</p>
    </div>
  );
}
