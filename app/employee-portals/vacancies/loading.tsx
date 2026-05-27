import { Card } from "@/components/ui/card";

function Pulse({ className }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded bg-slate-200/60 ${className ?? ""}`}
    />
  );
}

export default function VacanciesLoading() {
  return (
    <div className="mx-auto w-full space-y-5">
      {/* Hero skeleton */}
      <section className="relative box-border w-full overflow-hidden rounded border border-slate-800 bg-[linear-gradient(135deg,#070707_0%,#111827_52%,#2C1605_100%)] p-5 sm:p-6 lg:p-8">
        <Pulse className="h-6 w-36 !bg-slate-700/50" />
        <Pulse className="mt-5 h-8 w-56 !bg-slate-700/50 sm:w-72" />
        <Pulse className="mt-3 h-4 w-44 !bg-slate-700/40 sm:w-60" />
      </section>

      <div className="space-y-5 sm:space-y-7">
        {/* Filters skeleton */}
        <Card className="rounded-lg border border-gray-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.08)] sm:p-6">
          <div className="mb-4 flex gap-2">
            <Pulse className="h-5 w-16" />
            <Pulse className="h-5 w-32" />
          </div>
          <div className="grid gap-4 xl:grid-cols-[1fr_1fr_auto]">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i}>
                <Pulse className="mb-2 h-3 w-16" />
                <Pulse className="h-10 w-full" />
              </div>
            ))}
            <div className="flex items-end gap-2">
              <Pulse className="h-10 w-20" />
              <Pulse className="h-10 w-16" />
            </div>
          </div>
        </Card>

        {/* Stat cards skeleton */}
        <Card className="rounded-lg border border-gray-200 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.08)]">
          <div className="grid grid-cols-2 gap-px lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="px-3 py-3 sm:px-4 sm:py-4">
                <Pulse className="h-3.5 w-24" />
                <Pulse className="mt-2 h-6 w-16" />
                <Pulse className="mt-1.5 h-3 w-20" />
              </div>
            ))}
          </div>
        </Card>

        {/* Vacancy table skeleton */}
        <Card className="rounded-lg border border-gray-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.08)] sm:p-6">
          <Pulse className="mb-1 h-3 w-24" />
          <Pulse className="mb-1 h-4 w-32" />
          <Pulse className="mb-5 h-3 w-48" />
          <div className="space-y-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Pulse className="h-4 w-16 shrink-0" />
                <Pulse className="h-4 flex-1" />
                <Pulse className="h-4 w-20 shrink-0" />
                <Pulse className="h-4 w-20 shrink-0" />
                <Pulse className="h-5 w-14 shrink-0" />
                <Pulse className="h-4 w-20 shrink-0" />
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
