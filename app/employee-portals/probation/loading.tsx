import { Card } from "@/components/ui/card";

function Pulse({ className }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded bg-slate-200/60 ${className ?? ""}`}
    />
  );
}

export default function ProbationLoading() {
  return (
    <div className="mx-auto w-full space-y-5">
      {/* Hero skeleton */}
      <section className="relative box-border w-full overflow-hidden rounded border border-slate-800 bg-[linear-gradient(135deg,#070707_0%,#111827_52%,#2C1605_100%)] p-5 sm:p-6 lg:p-8">
        <Pulse className="h-6 w-36 !bg-slate-700/50" />
        <Pulse className="mt-5 h-8 w-56 !bg-slate-700/50 sm:w-72" />
        <Pulse className="mt-3 h-4 w-44 !bg-slate-700/40 sm:w-60" />
      </section>

      <div className="space-y-5 sm:space-y-7">
        {/* Stat cards skeleton */}
        <Card className="rounded-lg border border-gray-200 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.08)]">
          <div className="grid grid-cols-2 gap-px lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="px-4 py-4">
                <Pulse className="h-3.5 w-28" />
                <Pulse className="mt-2 h-7 w-12" />
                <Pulse className="mt-1.5 h-3 w-24" />
              </div>
            ))}
          </div>
        </Card>

        {/* Zone distribution skeleton */}
        <Card className="rounded-lg border border-gray-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.08)] sm:p-5">
          <Pulse className="mb-1 h-4 w-32" />
          <Pulse className="mb-3 h-3 w-48" />
          <Pulse className="h-4 w-full" />
          <div className="mt-2.5 flex gap-4">
            <Pulse className="h-3 w-16" />
            <Pulse className="h-3 w-20" />
            <Pulse className="h-3 w-16" />
          </div>
        </Card>

        {/* Filters skeleton */}
        <Card className="rounded-lg border border-gray-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.08)] sm:p-5">
          <div className="mb-3 flex gap-2">
            <Pulse className="h-5 w-16" />
            <Pulse className="h-5 w-32" />
          </div>
          <div className="grid gap-3 xl:grid-cols-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i}>
                <Pulse className="mb-1.5 h-3 w-12" />
                <Pulse className="h-10 w-full" />
              </div>
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <Pulse className="h-9 w-16" />
            <Pulse className="h-9 w-14" />
          </div>
        </Card>

        {/* Table skeleton */}
        <Card className="rounded-lg border border-gray-200 bg-white p-0 shadow-[0_1px_3px_rgba(15,23,42,0.08)]">
          <div className="space-y-0">
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className="flex items-center gap-3 border-b border-gray-100 px-4 py-3"
              >
                <Pulse className="h-4 w-28 shrink-0" />
                <Pulse className="h-4 flex-1" />
                <Pulse className="h-4 w-20 shrink-0" />
                <Pulse className="h-4 w-16 shrink-0" />
                <Pulse className="h-4 w-16 shrink-0" />
                <Pulse className="h-1.5 w-24 shrink-0" />
                <Pulse className="h-5 w-14 shrink-0" />
                <Pulse className="h-5 w-16 shrink-0" />
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
