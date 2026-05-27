import { Card } from "@/components/ui/card";

/**
 * Shared skeleton building blocks for employee-portal `loading.tsx` files.
 * Three templates cover the vast majority of pages:
 *
 *  - `RedirectSkeleton`  — for thin redirect pages and minimal flows
 *  - `FormSkeleton`      — for single-form pages (excuses, expenses, training-manager create)
 *  - `DashboardSkeleton` — for KPI + chart pages (incentive, marketing, coaching, etc.)
 *
 * Each template renders the dark hero placeholder + content placeholders
 * sized roughly to the real page, so the user sees something stable
 * during the SSR fetch + hydration window.
 */

function Pulse({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`animate-pulse rounded bg-slate-200/60 ${className ?? ""}`}
    />
  );
}

function HeroSkeleton({ badgeWidth = "w-36" }: { badgeWidth?: string }) {
  return (
    <section className="relative box-border w-full overflow-hidden rounded border border-slate-800 bg-[linear-gradient(135deg,#070707_0%,#111827_52%,#2C1605_100%)] p-5 sm:p-6 lg:p-8">
      <Pulse className={`h-6 ${badgeWidth} !bg-slate-700/50`} />
      <Pulse className="mt-5 h-8 w-56 !bg-slate-700/50 sm:w-72" />
      <Pulse className="mt-3 h-4 w-64 !bg-slate-700/40 sm:w-80" />
    </section>
  );
}

const cardShadow = "shadow-[0_1px_3px_rgba(15,23,42,0.06)]";

/* ------------------------------------------------------------------ */
/*  Template 1 — minimal redirect / thin pages                         */
/* ------------------------------------------------------------------ */

export function RedirectSkeleton() {
  return (
    <div className="mx-auto w-full space-y-5">
      <HeroSkeleton />
      <Card className={`rounded-lg border border-gray-100 bg-white p-4 sm:p-5 ${cardShadow}`}>
        <Pulse className="h-4 w-40" />
        <Pulse className="mt-2 h-3 w-64" />
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Template 2 — single-form pages                                     */
/* ------------------------------------------------------------------ */

export function FormSkeleton({ fieldCount = 4 }: { fieldCount?: number }) {
  return (
    <div className="mx-auto w-full space-y-5">
      <HeroSkeleton />
      <Card className={`rounded-lg border border-gray-100 bg-white ${cardShadow}`}>
        <div className="border-b border-gray-100 px-4 py-3 sm:px-5">
          <Pulse className="h-4 w-36" />
          <Pulse className="mt-1.5 h-3 w-56" />
        </div>
        <div className="space-y-4 px-4 py-4 sm:px-5 sm:py-5">
          {Array.from({ length: fieldCount }).map((_, i) => (
            <div key={i}>
              <Pulse className="mb-1.5 h-3 w-20" />
              <Pulse className="h-10 w-full" />
            </div>
          ))}
          <Pulse className="h-10 w-full" />
        </div>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Template 3 — KPI + 2-chart dashboards                              */
/* ------------------------------------------------------------------ */

export function DashboardSkeleton({
  kpiCount = 4,
  chartCount = 2,
}: {
  chartCount?: number;
  kpiCount?: number;
}) {
  return (
    <div className="mx-auto w-full space-y-5">
      <HeroSkeleton />

      {/* KPI strip */}
      <Card className={`rounded-lg border border-gray-100 bg-white p-0 ${cardShadow}`}>
        <div
          className={`grid grid-cols-2 gap-px sm:grid-cols-${Math.min(kpiCount, 4)}`}
          style={{
            gridTemplateColumns: `repeat(${Math.min(kpiCount, 4)}, minmax(0, 1fr))`,
          }}
        >
          {Array.from({ length: kpiCount }).map((_, i) => (
            <div className="px-4 py-4" key={i}>
              <Pulse className="h-3 w-20" />
              <Pulse className="mt-2 h-6 w-24" />
              <Pulse className="mt-2 h-3 w-32" />
            </div>
          ))}
        </div>
      </Card>

      {/* Filters card */}
      <Card className={`rounded-lg border border-gray-100 bg-white p-4 sm:p-5 ${cardShadow}`}>
        <Pulse className="mb-3 h-4 w-24" />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i}>
              <Pulse className="mb-1.5 h-3 w-16" />
              <Pulse className="h-10 w-full" />
            </div>
          ))}
        </div>
      </Card>

      {/* Charts row */}
      <section
        className={`grid gap-4 ${chartCount >= 2 ? "xl:grid-cols-2" : ""}`}
      >
        {Array.from({ length: chartCount }).map((_, i) => (
          <Card
            className={`rounded-lg border border-gray-100 bg-white p-4 sm:p-5 ${cardShadow}`}
            key={i}
          >
            <Pulse className="h-4 w-44" />
            <Pulse className="mt-1.5 h-3 w-56" />
            <Pulse className="mt-4 h-56 w-full" />
          </Card>
        ))}
      </section>

      {/* Table placeholder */}
      <Card className={`rounded-lg border border-gray-100 bg-white ${cardShadow}`}>
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
  );
}
