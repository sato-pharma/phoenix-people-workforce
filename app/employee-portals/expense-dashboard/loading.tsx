import { LandingNavyBoardLoading, LandingPanelLoading } from "@/components/employee-portal/landing-kit";
import { Pulse } from "@/components/employee-portal/skeleton-templates";

/*
 * The Expense Dashboard while it streams, drawn in the page's own parts so nothing jumps when it
 * lands: the flat title band (the shell's tick line, title and hairline), the one navy board, then
 * the white panels in the order the dashboard draws them.
 */
export default function ExpenseDashboardLoading() {
  return (
    <div className="mx-auto w-full space-y-5" aria-busy="true">
      <span className="sr-only">Loading the expense dashboard</span>
      <div className="min-w-0 border-b border-slate-200 pb-3 pt-0.5">
        <Pulse className="h-3 w-24" />
        <Pulse className="mt-2.5 h-7 w-full max-w-[16rem]" />
      </div>

      <div className="space-y-5 lg:space-y-6">
        <LandingNavyBoardLoading label="Expenses" />
        <LandingPanelLoading title="Filters" />
        <div className="grid gap-5 xl:grid-cols-2">
          <LandingPanelLoading title="Monthly Expense Trend" />
          <LandingPanelLoading title="Expense Breakdown by Category" />
        </div>
        <LandingPanelLoading title="Detailed Trip Table" />
      </div>
    </div>
  );
}
