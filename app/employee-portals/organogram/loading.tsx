import { Card } from "@/components/ui/card";

function Pulse({ className }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded bg-slate-200/60 ${className ?? ""}`}
    />
  );
}

export default function OrganogramLoading() {
  return (
    // Scope the portal square-corner override here too so the skeleton doesn't
    // flash rounded corners before the real shell mounts.
    <div className="employee-portal-shell mx-auto w-full space-y-5">
      {/* Hero skeleton */}
      <section className="relative box-border w-full overflow-hidden rounded border border-slate-800 bg-[linear-gradient(135deg,#070707_0%,#111827_52%,#2C1605_100%)] p-5 sm:p-6 lg:p-8">
        <Pulse className="h-6 w-36 !bg-slate-700/50" />
        <Pulse className="mt-5 h-8 w-48 !bg-slate-700/50 sm:w-64" />
        <Pulse className="mt-3 h-4 w-44 !bg-slate-700/40 sm:w-60" />
      </section>

      <div className="space-y-5 sm:space-y-7">
        {/* Stat cards skeleton — 5 cards */}
        <Card className="rounded-lg border border-gray-200 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.08)]">
          <div className="grid grid-cols-2 gap-px sm:grid-cols-3 xl:grid-cols-5">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="px-4 py-4">
                <Pulse className="h-3.5 w-24" />
                <Pulse className="mt-2 h-7 w-16" />
                <Pulse className="mt-2 h-1 w-full" />
                <Pulse className="mt-1.5 h-3 w-14" />
              </div>
            ))}
          </div>
        </Card>

        {/* Structure completion skeleton */}
        <Card className="rounded-lg border border-gray-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.08)] sm:p-5">
          <Pulse className="mb-1 h-4 w-36" />
          <Pulse className="mb-3 h-3 w-52" />
          <Pulse className="h-4 w-full" />
          <div className="mt-2.5 flex gap-4">
            <Pulse className="h-3 w-16" />
            <Pulse className="h-3 w-16" />
          </div>
        </Card>

        {/* Search / filters skeleton */}
        <Card className="rounded-lg border border-gray-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.08)] sm:p-5">
          <div className="mb-3 flex gap-2">
            <Pulse className="h-5 w-16" />
            <Pulse className="h-5 w-36" />
          </div>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <div>
              <Pulse className="mb-1.5 h-3 w-12" />
              <Pulse className="h-10 w-full" />
            </div>
            <div className="flex items-end gap-2">
              <Pulse className="h-10 w-20" />
            </div>
          </div>
        </Card>

        {/* Organogram tree skeleton */}
        <Card className="rounded-lg border border-gray-200 bg-white p-0 shadow-[0_1px_3px_rgba(15,23,42,0.08)]">
          <div className="border-b border-gray-200 px-4 py-4">
            <Pulse className="h-4 w-32" />
            <Pulse className="mt-1.5 h-3 w-56" />
          </div>
          <div className="flex flex-col items-center bg-slate-50/50 px-4 py-6">
            {/* CEO node */}
            <Pulse className="h-14 w-48 !rounded-lg !bg-slate-300/60" />
            <Pulse className="my-1 h-5 w-px !bg-slate-300/60" />
            {/* Line node */}
            <Pulse className="h-14 w-48 !bg-slate-200/80" />
            <Pulse className="my-1 h-5 w-px !bg-slate-300/60" />
            {/* NSM node */}
            <Pulse className="h-14 w-48 !bg-orange-100/60" />
            <Pulse className="my-2 h-px w-[80%] !bg-slate-300/60" />
            {/* Lane placeholders */}
            <div className="mt-4 grid w-full gap-3 sm:grid-cols-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div
                  key={i}
                  className="rounded-lg border border-gray-200 p-3"
                >
                  <Pulse className="h-12 w-full !bg-slate-200/70" />
                  <Pulse className="mt-2 h-8 w-full" />
                  <Pulse className="mt-1 h-8 w-full" />
                  <Pulse className="mt-1 h-8 w-full" />
                </div>
              ))}
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
