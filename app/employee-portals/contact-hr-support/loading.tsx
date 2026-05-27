import { Card } from "@/components/ui/card";

function Pulse({ className }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded bg-slate-200/60 ${className ?? ""}`}
    />
  );
}

export default function ContactHRSupportLoading() {
  return (
    <div className="mx-auto w-full space-y-5">
      {/* Hero skeleton */}
      <section className="relative box-border w-full overflow-hidden rounded border border-slate-800 bg-[linear-gradient(135deg,#070707_0%,#111827_52%,#2C1605_100%)] p-5 sm:p-6 lg:p-8">
        <Pulse className="h-6 w-40 !bg-slate-700/50" />
        <Pulse className="mt-5 h-8 w-60 !bg-slate-700/50 sm:w-80" />
        <Pulse className="mt-3 h-4 w-72 !bg-slate-700/40 sm:w-96" />
      </section>

      <div className="space-y-5">
        {/* Insights strip — 3 columns */}
        <Card className="rounded-lg border border-gray-100 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.06)]">
          <div className="grid grid-cols-1 gap-px sm:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div className="px-4 py-3" key={i}>
                <Pulse className="h-3 w-24" />
                <Pulse className="mt-2 h-5 w-20" />
                <Pulse className="mt-1.5 h-3 w-28" />
              </div>
            ))}
          </div>
        </Card>

        {/* 2-column main area: channels + form */}
        <div className="grid gap-5 lg:grid-cols-2">
          {/* HR channels card */}
          <Card className="rounded-lg border border-gray-100 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.06)]">
            <div className="border-b border-gray-100 px-4 py-3 sm:px-5">
              <Pulse className="h-4 w-40" />
              <Pulse className="mt-1.5 h-3 w-56" />
            </div>
            <div className="divide-y divide-gray-100">
              {Array.from({ length: 3 }).map((_, i) => (
                <div className="flex items-start gap-3 px-4 py-3 sm:px-5" key={i}>
                  <Pulse className="h-9 w-9 shrink-0 !rounded-md" />
                  <div className="flex-1">
                    <Pulse className="h-3.5 w-40" />
                    <Pulse className="mt-1.5 h-3 w-32" />
                    <Pulse className="mt-1 h-3 w-full" />
                  </div>
                  <Pulse className="h-9 w-20" />
                </div>
              ))}
            </div>
          </Card>

          {/* Request form card */}
          <Card className="rounded-lg border border-gray-100 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.06)]">
            <div className="border-b border-gray-100 px-4 py-3 sm:px-5">
              <Pulse className="h-4 w-36" />
              <Pulse className="mt-1.5 h-3 w-56" />
            </div>
            <div className="space-y-4 px-4 py-4 sm:px-5 sm:py-5">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i}>
                  <Pulse className="mb-1.5 h-3 w-20" />
                  <Pulse className="h-10 w-full" />
                </div>
              ))}
              <div>
                <Pulse className="mb-1.5 h-3 w-20" />
                <Pulse className="h-20 w-full" />
              </div>
              <Pulse className="h-10 w-full" />
            </div>
          </Card>
        </div>

        {/* Recent requests table skeleton */}
        <Card className="rounded-lg border border-gray-100 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.06)]">
          <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 sm:px-5">
            <Pulse className="h-4 w-36" />
            <Pulse className="h-3 w-20" />
          </div>
          <div className="px-4 py-10 text-center sm:px-5">
            <Pulse className="mx-auto h-3 w-40" />
            <Pulse className="mx-auto mt-2 h-3 w-64" />
          </div>
        </Card>
      </div>
    </div>
  );
}
