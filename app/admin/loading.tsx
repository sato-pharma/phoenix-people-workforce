export default function AdminLoading() {
  return (
    <div className="space-y-6">
      {/* Hero */}
      <div className="relative overflow-hidden border border-slate-950 bg-[linear-gradient(135deg,#070707_0%,#111827_52%,#2C1605_100%)] p-6 shadow-[0_28px_80px_rgba(15,23,42,0.38)] sm:p-8">
        <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-orange-500/0 via-orange-400/80 to-sky-500/0" />
        <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-orange-500/20 blur-3xl" />
        <div className="h-5 w-44 animate-pulse rounded-full bg-white/10" />
        <div className="mt-5 h-10 w-80 max-w-full animate-pulse bg-white/15" />
        <div className="mt-4 h-4 w-[520px] max-w-full animate-pulse rounded-full bg-white/10" />
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div
            className="h-32 animate-pulse border border-slate-200 bg-white shadow-[0_6px_20px_rgba(15,23,42,0.08)]"
            key={index}
          />
        ))}
      </div>

      {/* Module grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 8 }).map((_, index) => (
          <div
            className="h-[236px] animate-pulse border border-slate-200 bg-white shadow-[0_4px_16px_rgba(15,23,42,0.07)]"
            key={index}
          />
        ))}
      </div>
    </div>
  );
}
