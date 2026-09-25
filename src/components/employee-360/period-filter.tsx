import Link from "next/link";

import { cn } from "@/lib/utils";
import { PERIOD_PRESETS, type PeriodKey } from "@/lib/employee-360/period";

// A 40px tap target on a phone (the field force's device), back to the compact chip from md up.
function chip(active: boolean): string {
  return cn(
    "inline-flex min-h-10 items-center justify-center rounded-full border px-3 py-1.5 text-xs font-bold transition md:min-h-0",
    active
      ? "border-orange-500 bg-orange-500 text-white shadow-[0_4px_12px_rgba(249,115,22,0.3)]"
      : "border-slate-200 bg-white text-slate-500 hover:border-slate-300 hover:bg-slate-50",
  );
}

// Server component. Presets are plain links and the custom range is a GET form,
// so period filtering works with zero client JS (each choice re-renders the page
// on the server with the new window).
export function PeriodFilter({
  hrId,
  activeKey,
  from,
  to,
  basePath,
}: {
  hrId: string;
  activeKey: PeriodKey;
  from: string;
  to: string;
  /** Override the link base (e.g. the employee-portal's self-service route, which has no /[hrId] segment). Defaults to the admin detail route. */
  basePath?: string;
}) {
  const base = basePath ?? `/employee-360/${encodeURIComponent(hrId)}`;
  return (
    <div className="flex flex-col gap-3 rounded-[16px] border border-slate-200 bg-white p-3.5 shadow-sm sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-wrap gap-1.5">
        {PERIOD_PRESETS.map((p) => (
          <Link key={p.key} href={`${base}?preset=${p.key}`} className={chip(activeKey === p.key)}>
            {p.label}
          </Link>
        ))}
      </div>
      {/* FITS THE SCREEN (AGENTS.md §4). On a phone the two dates share one row as equal SHARES
          of the width (min-w-0 lets a native date input shrink below its intrinsic ~150px, and the
          portal floors inputs at 16px there, which is what made the old one-line row ~340px wide
          against 306px of room at 360) and Apply takes the row below. From sm up it is one line. */}
      <form
        method="get"
        action={base}
        className="grid w-full grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1.5 text-xs sm:flex sm:w-auto"
      >
        <input
          type="date"
          name="from"
          defaultValue={from}
          aria-label="From date"
          className="w-full min-w-0 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-slate-700 outline-none transition focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 sm:w-auto"
        />
        <span aria-hidden className="font-bold text-slate-300">→</span>
        <input
          type="date"
          name="to"
          defaultValue={to}
          aria-label="To date"
          className="w-full min-w-0 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-slate-700 outline-none transition focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 sm:w-auto"
        />
        <button type="submit" className={cn(chip(activeKey === "custom"), "col-span-3 cursor-pointer sm:col-span-1")}>
          Apply
        </button>
      </form>
    </div>
  );
}
