import { Card } from "@/components/ui/card";

function Pulse({ className }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded bg-slate-200/60 ${className ?? ""}`}
    />
  );
}

export default function SubmitExpenseLoading() {
  return (
    <div className="mx-auto w-full space-y-5">
      {/* Hero skeleton */}
      <section className="relative box-border w-full overflow-hidden rounded border border-slate-800 bg-[linear-gradient(135deg,#070707_0%,#111827_52%,#2C1605_100%)] p-5 sm:p-6 lg:p-8">
        <Pulse className="h-6 w-24 !bg-slate-700/50" />
        <Pulse className="mt-5 h-8 w-52 !bg-slate-700/50 sm:w-72" />
        <Pulse className="mt-3 h-4 w-72 !bg-slate-700/40 sm:w-[28rem]" />
      </section>

      <div className="space-y-5">
        {/* Wizard step indicator skeleton */}
        <Card className="rounded-lg border border-gray-100 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.06)]">
          <div className="grid grid-cols-3 gap-px">
            {Array.from({ length: 3 }).map((_, i) => (
              <div className="flex items-center gap-2 px-3 py-2.5" key={i}>
                <Pulse className="h-6 w-6 !rounded-sm" />
                <Pulse className="h-3 w-24 flex-1" />
              </div>
            ))}
          </div>
        </Card>

        {/* Request details card skeleton */}
        <Card className="rounded-lg border border-gray-100 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.06)] sm:p-5">
          <Pulse className="h-5 w-32" />
          <Pulse className="mt-2 h-5 w-72" />
          {/* Fields grid */}
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i}>
                <Pulse className="mb-1 h-3 w-20" />
                <Pulse className="h-10 w-full" />
              </div>
            ))}
          </div>
          {/* Notes textarea */}
          <div className="mt-3">
            <Pulse className="mb-1 h-3 w-14" />
            <Pulse className="h-24 w-full" />
          </div>
          {/* Auto calc summary */}
          <Pulse className="mt-5 h-5 w-44" />
          <div className="mt-3 grid gap-px border border-gray-100 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div className="px-3 py-3" key={i}>
                <Pulse className="h-3 w-20" />
                <Pulse className="mt-2 h-4 w-32" />
              </div>
            ))}
          </div>
        </Card>

        {/* Car evidence / Ticket upload card skeleton */}
        <Card className="rounded-lg border border-gray-100 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.06)] sm:p-5">
          <Pulse className="h-5 w-32" />
          <Pulse className="mt-2 h-5 w-64" />
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Pulse className="h-11 w-full" />
            <Pulse className="h-16 w-full" />
          </div>
        </Card>
      </div>
    </div>
  );
}
