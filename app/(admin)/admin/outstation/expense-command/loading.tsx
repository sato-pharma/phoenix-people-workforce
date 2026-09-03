import {
  pageHeaderRailClassName,
  pageHeaderRuleClassName,
} from "@/components/admin/admin-design-tokens";

export default function Loading() {
  return (
    <div className="space-y-5">
      {/* No dark band — see the note in AdminPageHero (owner, 2026-09-03). */}
      <div>
        <div className="relative pb-4 pl-3.5">
          <span aria-hidden="true" className={pageHeaderRailClassName} />
          <div className="h-3 w-40 animate-pulse bg-slate-200" />
          <div className="mt-3 h-6 w-2/3 animate-pulse bg-slate-200" />
          <div className="mt-2 h-3 w-1/2 animate-pulse bg-slate-100" />
        </div>
        <div aria-hidden="true" className={pageHeaderRuleClassName} />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, index) => (
          <div
            key={index}
            className="h-24 rounded-[18px] border border-slate-200 bg-white shadow-[0_16px_40px_rgba(15,23,42,0.06)]"
          >
            <div className="space-y-2 p-4">
              <div className="h-3 w-16 animate-pulse rounded bg-slate-200" />
              <div className="h-6 w-20 animate-pulse rounded bg-slate-200" />
            </div>
          </div>
        ))}
      </div>
      <div className="h-[520px] animate-pulse rounded-[18px] border border-slate-200 bg-slate-100" />
    </div>
  );
}
