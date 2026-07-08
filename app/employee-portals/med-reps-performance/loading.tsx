import { Card } from "@/components/ui/card";

function Pulse({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-slate-200/60 ${className ?? ""}`} />;
}

export default function MedRepsPerformanceLoading() {
  return (
    <div className="mx-auto w-full space-y-5">
      {/* Hero skeleton */}
      <section className="relative box-border w-full overflow-hidden rounded border border-slate-800 bg-[linear-gradient(135deg,#070707_0%,#111827_52%,#2C1605_100%)] p-5 sm:p-6 lg:p-8">
        <Pulse className="h-6 w-36 !bg-slate-700/50" />
        <Pulse className="mt-5 h-8 w-64 !bg-slate-700/50 sm:w-80" />
        <Pulse className="mt-3 h-4 w-48 !bg-slate-700/40 sm:w-64" />
      </section>

      <div className="space-y-5 sm:space-y-7">
        {/* Line Snapshot skeleton */}
        <Card className="rounded-lg border border-gray-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.08)] sm:p-6">
          <div className="mb-4 grid gap-4 md:grid-cols-[1fr_auto] md:items-end">
            <div>
              <Pulse className="h-5 w-40" />
              <Pulse className="mt-3 h-7 w-48" />
              <Pulse className="mt-2 h-4 w-56" />
            </div>
            <div className="w-full sm:w-36">
              <Pulse className="h-4 w-28" />
              <Pulse className="mt-2 h-8 w-20" />
            </div>
          </div>
          <div className="mb-4 flex gap-1.5">
            {Array.from({ length: 5 }).map((_, i) => (
              <Pulse key={i} className="h-7 w-20" />
            ))}
          </div>
          <div className="grid grid-cols-2 gap-px lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="px-3 py-3 sm:px-4 sm:py-4">
                <Pulse className="h-3.5 w-20" />
                <Pulse className="mt-2 h-6 w-28" />
              </div>
            ))}
          </div>
        </Card>

        {/* Achievement distribution skeleton */}
        <Card className="rounded-lg border border-gray-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.08)] sm:p-5">
          <Pulse className="mb-3 h-3.5 w-40" />
          <Pulse className="h-5 w-full" />
          <div className="mt-2.5 flex gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Pulse key={i} className="h-3 w-20" />
            ))}
          </div>
        </Card>

        {/* Charts skeleton */}
        <div className="grid gap-5 lg:grid-cols-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <Card key={i} className="rounded-lg border border-gray-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.08)] sm:p-6">
              <Pulse className="mb-4 h-4 w-44" />
              <Pulse className="h-52 w-full" />
            </Card>
          ))}
        </div>

        {/* Leaderboard skeleton */}
        <Card className="rounded-lg border border-gray-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.08)] sm:p-6">
          <Pulse className="h-3.5 w-24" />
          <Pulse className="mt-2 h-6 w-44" />
          <div className="mt-5 space-y-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Pulse className="h-6 w-6 shrink-0" />
                <Pulse className="h-4 flex-1" />
                <Pulse className="h-4 w-14 shrink-0" />
                <Pulse className="h-4 w-20 shrink-0" />
                <Pulse className="h-4 w-20 shrink-0" />
                <Pulse className="h-4 w-16 shrink-0" />
              </div>
            ))}
          </div>
        </Card>

        {/* Section divider skeleton */}
        <div className="flex items-center gap-3 px-1">
          <div className="h-px flex-1 bg-gray-200" />
          <Pulse className="h-3 w-52" />
          <div className="h-px flex-1 bg-gray-200" />
        </div>

        {/* Product breakdown skeleton */}
        <Card className="rounded-lg border border-gray-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.08)] sm:p-6">
          <Pulse className="h-3.5 w-28" />
          <Pulse className="mt-2 h-5 w-48" />
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="rounded-lg border border-slate-100 p-4">
                <div className="flex items-center gap-3">
                  <Pulse className="h-9 w-9 shrink-0" />
                  <div className="flex-1">
                    <Pulse className="h-4 w-32" />
                    <Pulse className="mt-1.5 h-3 w-20" />
                  </div>
                  <Pulse className="h-6 w-14" />
                </div>
                <Pulse className="mt-3 h-2 w-full" />
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
