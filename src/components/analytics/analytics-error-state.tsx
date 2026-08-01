import { AlertTriangle } from "lucide-react";

type Props = {
  /** What could not be loaded, in the reader's words — e.g. "Source of Sales by area". */
  what?: string;
};

/**
 * Shown when a dashboard load FAILED, as opposed to returning no rows.
 *
 * AnalyticsEmptyState asserts "No data available for the selected filters", which is a claim about
 * the data. When a query errors or times out we cannot make that claim — the figures on the page are
 * incomplete and a blank must not be read as a zero. This states that plainly.
 */
export function AnalyticsErrorState({ what }: Props) {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 border border-destructive/40 bg-destructive/5 px-4 py-3"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      <div className="space-y-1">
        <p className="text-sm font-medium text-destructive">
          {what ? `${what} could not be loaded.` : "Some of this page could not be loaded."}
        </p>
        <p className="text-sm text-muted-foreground">
          The figures shown are incomplete. Treat blanks as unknown, not as zero, and reload before
          using these numbers. If it keeps happening, narrow the period or filters — a very wide
          range can time out.
        </p>
      </div>
    </div>
  );
}
