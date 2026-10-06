"use client";

import { usePathname } from "next/navigation";

/**
 * Where the loading screen is showing decides its header, so the placeholder matches the page
 * about to replace it:
 *
 *   - the portal LANDING (`/employee-portals`) has no page header at all — the identity band is
 *     its first thing — so the skeleton draws none;
 *   - every other portal page opens under the navy command header, so the skeleton draws a navy
 *     block in its place instead of the white glass one it used to, which flashed a look no
 *     portal page has;
 *   - anything else (the admin shell's leave-management route renders this too) keeps the
 *     original glass header, byte for byte.
 */
function isPortalPath(pathname: string) {
  return (
    pathname === "/employee-portals" ||
    pathname.startsWith("/employee-portals/") ||
    pathname === "/payslips" ||
    pathname.startsWith("/payslips/") ||
    pathname.startsWith("/employee/")
  );
}

export function EmployeePortalRouteLoading() {
  const pathname = usePathname() ?? "";
  const portal = isPortalPath(pathname);
  const landing = pathname === "/employee-portals";

  return (
    <div aria-live="polite" className="employee-portal-route-loading space-y-6" role="status">
      <span className="sr-only">Loading employee portal page</span>

      {!portal ? (
        <section className="relative isolate overflow-hidden rounded border border-white/80 bg-white/86 p-5 shadow-[0_22px_54px_rgba(15,23,42,0.08)] backdrop-blur-xl sm:p-6">
          <div className="pointer-events-none absolute -right-20 -top-24 h-56 w-56 rounded-md bg-orange-200/45 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-24 left-1/4 h-52 w-52 rounded-md bg-sky-200/35 blur-3xl" />
          <div className="relative flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-3">
              <div className="employee-portal-skeleton h-4 w-32 rounded" />
              <div className="employee-portal-skeleton h-9 w-[min(82vw,440px)] rounded" />
              <div className="employee-portal-skeleton h-4 w-[min(72vw,560px)] rounded" />
            </div>
            <div className="grid grid-cols-3 gap-2 sm:gap-3">
              <div className="employee-portal-skeleton h-12 w-20 rounded sm:w-28" />
              <div className="employee-portal-skeleton h-12 w-20 rounded sm:w-28" />
              <div className="employee-portal-skeleton h-12 w-20 rounded sm:w-28" />
            </div>
          </div>
        </section>
      ) : landing ? null : (
        // The same frame as EmployeePortalPageShell's command header: navy, square, one badge,
        // a title and a line of description — as SHARES of the width, never fixed pixels.
        <section className="rounded-sm border border-slate-800 bg-[#08111f] px-4 py-4 sm:px-5 sm:py-5 lg:px-6">
          <div className="h-5 w-full max-w-[8rem] animate-pulse bg-white/10" />
          <div className="mt-3 h-8 w-full max-w-[20rem] animate-pulse bg-white/15" />
          <div className="mt-2 h-4 w-full max-w-[32rem] animate-pulse bg-white/10" />
        </section>
      )}

      <section className="grid gap-4 md:grid-cols-3">
        {[0, 1, 2].map((item) => (
          <div
            className="rounded border border-white/80 bg-white/82 p-5 shadow-[0_16px_38px_rgba(15,23,42,0.07)] backdrop-blur-xl"
            key={item}
          >
            <div className="mb-5 flex items-center justify-between">
              <div className="employee-portal-skeleton h-10 w-10 rounded" />
              <div className="employee-portal-skeleton h-5 w-16 rounded" />
            </div>
            <div className="employee-portal-skeleton h-4 w-24 rounded" />
            <div className="employee-portal-skeleton mt-3 h-8 w-32 rounded" />
            <div className="employee-portal-skeleton mt-4 h-2.5 w-full rounded" />
          </div>
        ))}
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.35fr_0.65fr]">
        <div className="rounded border border-white/80 bg-white/82 p-5 shadow-[0_16px_42px_rgba(15,23,42,0.07)] backdrop-blur-xl sm:p-6">
          {/* FITS THE SCREEN. These two bars used to be FIXED widths (w-44 and w-64) beside a
              w-24 block in a row that could not wrap, giving the card a 394px min-content. Its
              grid column is auto-sized, so at 375px the column grew to 394 and the whole portal
              scrolled sideways — on EVERY page load, before any real content existed to blame.
              A skeleton is a placeholder: it must claim a share of the width, never a fixed
              number of pixels. The max-w caps keep the desktop proportions identical. */}
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 flex-1 space-y-3">
              <div className="employee-portal-skeleton h-5 w-full max-w-[11rem] rounded" />
              <div className="employee-portal-skeleton h-3.5 w-full max-w-[16rem] rounded" />
            </div>
            <div className="employee-portal-skeleton h-9 w-24 shrink-0 rounded" />
          </div>
          <div className="employee-portal-skeleton h-[260px] rounded" />
        </div>

        <div className="rounded border border-white/80 bg-white/82 p-5 shadow-[0_16px_42px_rgba(15,23,42,0.07)] backdrop-blur-xl sm:p-6">
          <div className="employee-portal-skeleton h-5 w-36 rounded" />
          <div className="mt-6 space-y-4">
            {[0, 1, 2, 3].map((item) => (
              <div className="flex items-center gap-3" key={item}>
                <div className="employee-portal-skeleton h-10 w-10 rounded" />
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="employee-portal-skeleton h-3.5 w-3/4 rounded" />
                  <div className="employee-portal-skeleton h-3 w-1/2 rounded" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
