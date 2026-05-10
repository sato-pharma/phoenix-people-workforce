export default function AdminLoading() {
  return (
    <div className="min-h-[calc(100vh-7rem)] rounded-[32px] border border-[#E2E8F0] bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.10),transparent_30%),linear-gradient(180deg,#F8FAFC_0%,#EEF3F8_100%)] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] sm:p-6 xl:p-8">
      <div className="space-y-6">
        <div className="relative overflow-hidden rounded-3xl border border-[#D8E0EA] bg-white/95 p-7 shadow-[0_20px_54px_rgba(15,23,42,0.08)]">
          <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-orange-200/35 blur-3xl" />
          <div className="h-4 w-40 animate-pulse rounded-full bg-orange-100" />
          <div className="mt-5 h-8 w-80 max-w-full animate-pulse rounded-2xl bg-slate-200" />
          <div className="mt-3 h-4 w-[520px] max-w-full animate-pulse rounded-full bg-slate-100" />
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div
              className="h-32 animate-pulse rounded-3xl border border-[#E2E8F0] bg-white/90 shadow-[0_16px_36px_rgba(15,23,42,0.06)]"
              key={index}
            />
          ))}
        </div>
        <div className="h-[420px] animate-pulse rounded-3xl border border-[#E2E8F0] bg-white/90 shadow-[0_18px_42px_rgba(15,23,42,0.06)]" />
      </div>
    </div>
  );
}
