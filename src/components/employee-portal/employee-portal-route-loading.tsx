export function EmployeePortalRouteLoading() {
  return (
    <div aria-live="polite" className="employee-portal-route-loading space-y-6" role="status">
      <span className="sr-only">Loading employee portal page</span>

      <section className="relative isolate overflow-hidden rounded-[28px] border border-white/80 bg-white/86 p-5 shadow-[0_22px_54px_rgba(15,23,42,0.08)] backdrop-blur-xl sm:p-6">
        <div className="pointer-events-none absolute -right-20 -top-24 h-56 w-56 rounded-full bg-orange-200/45 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-24 left-1/4 h-52 w-52 rounded-full bg-sky-200/35 blur-3xl" />
        <div className="relative flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-3">
            <div className="employee-portal-skeleton h-4 w-32 rounded-full" />
            <div className="employee-portal-skeleton h-9 w-[min(82vw,440px)] rounded-2xl" />
            <div className="employee-portal-skeleton h-4 w-[min(72vw,560px)] rounded-full" />
          </div>
          <div className="grid grid-cols-3 gap-2 sm:gap-3">
            <div className="employee-portal-skeleton h-12 w-20 rounded-2xl sm:w-28" />
            <div className="employee-portal-skeleton h-12 w-20 rounded-2xl sm:w-28" />
            <div className="employee-portal-skeleton h-12 w-20 rounded-2xl sm:w-28" />
          </div>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        {[0, 1, 2].map((item) => (
          <div
            className="rounded-[24px] border border-white/80 bg-white/82 p-5 shadow-[0_16px_38px_rgba(15,23,42,0.07)] backdrop-blur-xl"
            key={item}
          >
            <div className="mb-5 flex items-center justify-between">
              <div className="employee-portal-skeleton h-10 w-10 rounded-2xl" />
              <div className="employee-portal-skeleton h-5 w-16 rounded-full" />
            </div>
            <div className="employee-portal-skeleton h-4 w-24 rounded-full" />
            <div className="employee-portal-skeleton mt-3 h-8 w-32 rounded-xl" />
            <div className="employee-portal-skeleton mt-4 h-2.5 w-full rounded-full" />
          </div>
        ))}
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.35fr_0.65fr]">
        <div className="rounded-[28px] border border-white/80 bg-white/82 p-5 shadow-[0_16px_42px_rgba(15,23,42,0.07)] backdrop-blur-xl sm:p-6">
          <div className="mb-5 flex items-center justify-between">
            <div>
              <div className="employee-portal-skeleton h-5 w-44 rounded-full" />
              <div className="employee-portal-skeleton mt-3 h-3.5 w-64 rounded-full" />
            </div>
            <div className="employee-portal-skeleton h-9 w-24 rounded-full" />
          </div>
          <div className="employee-portal-skeleton h-[260px] rounded-[22px]" />
        </div>

        <div className="rounded-[28px] border border-white/80 bg-white/82 p-5 shadow-[0_16px_42px_rgba(15,23,42,0.07)] backdrop-blur-xl sm:p-6">
          <div className="employee-portal-skeleton h-5 w-36 rounded-full" />
          <div className="mt-6 space-y-4">
            {[0, 1, 2, 3].map((item) => (
              <div className="flex items-center gap-3" key={item}>
                <div className="employee-portal-skeleton h-10 w-10 rounded-2xl" />
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="employee-portal-skeleton h-3.5 w-3/4 rounded-full" />
                  <div className="employee-portal-skeleton h-3 w-1/2 rounded-full" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
