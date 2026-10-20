// Recruitment workspace — the loading outline: two lines per row, the same shape the rows will take,
// so nothing jumps when they arrive (owner, 20 Oct 2026: "skeletons while loading").

import { cn } from "@/lib/utils";

const NAME_WIDTHS = ["w-40", "w-52", "w-36", "w-48", "w-44", "w-56"];
const CHIP_WIDTHS = [
  ["w-28", "w-36", "w-24", "w-32"],
  ["w-32", "w-24", "w-40"],
  ["w-24", "w-28", "w-32", "w-20", "w-28"],
];

export function RowSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading CVs" role="status">
      {Array.from({ length: rows }, (_, index) => (
        <div className="relative border-b border-slate-200 bg-white py-3 pl-5 pr-3" key={index}>
          <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-slate-200" />
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn("h-4 animate-pulse bg-slate-200", NAME_WIDTHS[index % NAME_WIDTHS.length])} />
            <span className="h-4 w-16 animate-pulse bg-slate-100" />
            <span className="h-4 w-24 animate-pulse bg-slate-100" />
          </div>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {CHIP_WIDTHS[index % CHIP_WIDTHS.length].map((width, chip) => (
              <span className={cn("h-5 animate-pulse bg-slate-100", width)} key={chip} />
            ))}
          </div>
        </div>
      ))}
      <span className="sr-only">Loading CVs…</span>
    </div>
  );
}
