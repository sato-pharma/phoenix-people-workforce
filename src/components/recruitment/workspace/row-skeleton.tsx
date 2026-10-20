// Recruitment workspace — the loading outline: the bordered table's own ruled rows, the same shape the
// candidates will take, so nothing jumps when they arrive (owner, 20 Oct 2026: "skeletons while
// loading", then "a polished premium table with borders").

import { adminPanelHeaderClassName } from "@/components/admin/admin-design-tokens";
import { cn } from "@/lib/utils";

const NAME_WIDTHS = ["w-40", "w-52", "w-36", "w-48", "w-44", "w-56"];
const VALUE_WIDTHS = ["w-24", "w-32", "w-20", "w-28", "w-16"];

export function RowSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading CVs" role="status">
      <div aria-hidden className={cn("grid h-10 grid-cols-[minmax(0,2fr)_minmax(0,1.5fr)_minmax(0,1.5fr)]", adminPanelHeaderClassName)}>
        {[0, 1, 2].map((cell) => (
          <span className="border-r border-white/10 last:border-r-0" key={cell} />
        ))}
      </div>
      {Array.from({ length: rows }, (_, index) => (
        <div
          className={cn("relative grid grid-cols-[minmax(0,2fr)_minmax(0,1.5fr)_minmax(0,1.5fr)] border-t border-slate-200", index % 2 === 1 ? "bg-slate-50/70" : "bg-white")}
          key={index}
        >
          <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-slate-200" />
          <div className="space-y-2 border-r border-slate-200 px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn("h-4 animate-pulse bg-slate-200", NAME_WIDTHS[index % NAME_WIDTHS.length])} />
              <span className="h-4 w-16 animate-pulse bg-slate-100" />
            </div>
            <span className="block h-3 w-28 animate-pulse bg-slate-100" />
          </div>
          {[0, 1].map((cell) => (
            <div className="space-y-2 border-r border-slate-200 px-3 py-2.5 last:border-r-0" key={cell}>
              <span className={cn("block h-3 animate-pulse bg-slate-100", VALUE_WIDTHS[(index + cell) % VALUE_WIDTHS.length])} />
              <span className={cn("block h-3 animate-pulse bg-slate-100", VALUE_WIDTHS[(index + cell + 2) % VALUE_WIDTHS.length])} />
              <span className={cn("block h-3 animate-pulse bg-slate-100", VALUE_WIDTHS[(index + cell + 4) % VALUE_WIDTHS.length])} />
            </div>
          ))}
        </div>
      ))}
      <span className="sr-only">Loading CVs…</span>
    </div>
  );
}
