import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { LandingPanelLoading } from "@/components/employee-portal/landing-kit";
import { Pulse } from "@/components/employee-portal/skeleton-templates";

/*
 * Team Expenses while it streams, in the page's own order: the flat title band, the filters panel,
 * the four team figures, then the trend, the ranking, the district-manager summary and the recent
 * trips, each under the name the page gives it.
 */
export default function TeamExpensesLoading() {
  return (
    <div className="mx-auto w-full space-y-5" aria-busy="true">
      <span className="sr-only">Loading team expenses</span>
      <div className="min-w-0 border-b border-slate-200 pb-3 pt-0.5">
        <Pulse className="h-3 w-24" />
        <Pulse className="mt-2.5 h-7 w-full max-w-[16rem]" />
      </div>

      <div className="space-y-5 sm:space-y-6">
        <LandingPanelLoading title="Filters" />
        <div className={`grid grid-cols-2 gap-px border border-slate-200 bg-slate-200 lg:grid-cols-4 ${adminSoftDepthClassName}`}>
          {Array.from({ length: 4 }).map((_, i) => (
            <div className="bg-white px-3 py-3 sm:px-4" key={i}>
              <Pulse className="h-3 w-20" />
              <Pulse className="mt-2 h-6 w-28" />
            </div>
          ))}
        </div>
        <div className="grid gap-5 lg:grid-cols-2">
          <LandingPanelLoading title="Monthly Trend" />
          <LandingPanelLoading title="DSM Expense Ranking" />
        </div>
        <LandingPanelLoading title="DSM Summary" />
        <LandingPanelLoading title="Recent Trips" />
      </div>
    </div>
  );
}
