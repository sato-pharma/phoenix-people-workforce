import { Card } from "@/components/ui/card";

function Pulse({ className }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded bg-slate-200/60 ${className ?? ""}`}
    />
  );
}

export default function ExpenseDashboardLoading() {
  return (
    <div className="mx-auto w-full space-y-5">
      {/* Hero skeleton */}
      <section className="relative box-border w-full overflow-hidden rounded border border-slate-800 bg-[linear-gradient(135deg,#070707_0%,#111827_52%,#2C1605_100%)] p-5 sm:p-6 lg:p-8">
        <Pulse className="h-6 w-28 !bg-slate-700/50" />
        <Pulse className="mt-5 h-8 w-56 !bg-slate-700/50 sm:w-72" />
        <Pulse className="mt-3 h-4 w-60 !bg-slate-700/40 sm:w-80" />
      </section>

      <div className="space-y-5">
        {/* KPI stat cards skeleton — 5 cards */}
        <Card className="rounded-lg border border-gray-100 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.06)]">
          <div className="grid grid-cols-2 gap-px sm:grid-cols-3 xl:grid-cols-5">
            {Array.from({ length: 5 }).map((_, i) => (
              <div className="px-4 py-4" key={i}>
                <Pulse className="h-3 w-20" />
                <Pulse className="mt-2.5 h-6 w-24" />
                <Pulse className="mt-2 h-3 w-32" />
              </div>
            ))}
          </div>
        </Card>

        {/* Admin key cards skeleton — 3 cards */}
        <Card className="rounded-lg border border-gray-100 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.06)]">
          <div className="grid grid-cols-1 gap-px sm:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div className="px-4 py-4" key={i}>
                <Pulse className="h-3 w-24" />
                <Pulse className="mt-2.5 h-6 w-28" />
                <Pulse className="mt-2 h-3 w-32" />
              </div>
            ))}
          </div>
        </Card>

        {/* Insights skeleton — 3 columns */}
        <Card className="rounded-lg border border-gray-100 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.06)]">
          <div className="grid grid-cols-1 gap-px sm:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div className="px-4 py-3" key={i}>
                <Pulse className="h-3 w-24" />
                <Pulse className="mt-2 h-4 w-36" />
                <Pulse className="mt-1.5 h-3 w-28" />
              </div>
            ))}
          </div>
        </Card>

        {/* Filters skeleton */}
        <Card className="rounded-lg border border-gray-100 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.06)] sm:p-5">
          <div className="mb-4 flex items-center justify-between">
            <Pulse className="h-5 w-16" />
            <Pulse className="h-9 w-20" />
          </div>
          <Pulse className="mb-3 h-3 w-12" />
          <Pulse className="h-10 w-full sm:w-96" />
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i}>
                <Pulse className="mb-1.5 h-3 w-16" />
                <Pulse className="h-10 w-full" />
              </div>
            ))}
          </div>
        </Card>

        {/* Charts row 1 skeleton */}
        <section className="grid gap-4 xl:grid-cols-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <Card
              className="rounded-lg border border-gray-100 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.06)] sm:p-5"
              key={i}
            >
              <Pulse className="h-4 w-44" />
              <Pulse className="mt-1.5 h-3 w-56" />
              <Pulse className="mt-4 h-56 w-full" />
            </Card>
          ))}
        </section>

        {/* Charts row 2 skeleton */}
        <section className="grid gap-4 xl:grid-cols-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <Card
              className="rounded-lg border border-gray-100 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.06)] sm:p-5"
              key={i}
            >
              <Pulse className="h-4 w-44" />
              <Pulse className="mt-1.5 h-3 w-56" />
              <div className="mt-4 space-y-2">
                {Array.from({ length: 4 }).map((__, j) => (
                  <div key={j}>
                    <Pulse className="h-3 w-full" />
                    <Pulse className="mt-1.5 h-1.5 w-full" />
                  </div>
                ))}
              </div>
            </Card>
          ))}
        </section>

        {/* Table skeleton */}
        <Card className="rounded-lg border border-gray-100 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.06)]">
          <div className="border-b border-gray-100 p-3">
            <Pulse className="h-5 w-32" />
          </div>
          <div className="divide-y divide-gray-100 p-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div className="flex items-center gap-3 py-3" key={i}>
                <Pulse className="h-3 w-16" />
                <Pulse className="h-3 w-20" />
                <Pulse className="h-3 w-24 flex-1" />
                <Pulse className="h-3 w-16" />
                <Pulse className="h-5 w-20" />
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
