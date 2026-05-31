export default function CeoCommandCenterLoading() {
  return (
    <div className="space-y-6">
      <div className="relative overflow-hidden rounded-[24px] border border-slate-800 bg-slate-900 p-8 shadow-[0_24px_60px_rgba(15,23,42,0.28)]">
        <div className="pointer-events-none absolute -right-20 -top-24 h-72 w-72 rounded-full bg-orange-500/20 blur-3xl" />
        <div className="h-3 w-48 animate-pulse rounded-full bg-white/10" />
        <div className="mt-5 h-8 w-72 max-w-full animate-pulse rounded-2xl bg-white/15" />
        <div className="mt-3 h-4 w-56 max-w-full animate-pulse rounded-full bg-white/10" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div
            className="h-32 animate-pulse rounded-[18px] border border-[#E2E8F0] bg-white/90 shadow-[0_8px_22px_rgba(15,23,42,0.05)]"
            key={index}
          />
        ))}
      </div>
      <div className="h-[260px] animate-pulse rounded-[18px] border border-[#E2E8F0] bg-white/90 shadow-[0_8px_22px_rgba(15,23,42,0.05)]" />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {Array.from({ length: 4 }).map((_, index) => (
          <div
            className="h-56 animate-pulse rounded-[18px] border border-[#E2E8F0] bg-white/90 shadow-[0_8px_22px_rgba(15,23,42,0.05)]"
            key={index}
          />
        ))}
      </div>
    </div>
  );
}
