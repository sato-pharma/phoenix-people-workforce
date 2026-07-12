import Link from "next/link";

import { PERIOD_PRESETS, type PeriodKey } from "@/lib/employee-360/period";

function chip(active: boolean): string {
  return active
    ? "rounded-full border border-primary bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary"
    : "rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted/60";
}

// Server component. Presets are plain links and the custom range is a GET form,
// so period filtering works with zero client JS (each choice re-renders the page
// on the server with the new window).
export function PeriodFilter({
  hrId,
  activeKey,
  from,
  to,
}: {
  hrId: string;
  activeKey: PeriodKey;
  from: string;
  to: string;
}) {
  const base = `/employee-360/${encodeURIComponent(hrId)}`;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-wrap gap-1.5">
        {PERIOD_PRESETS.map((p) => (
          <Link key={p.key} href={`${base}?preset=${p.key}`} className={chip(activeKey === p.key)}>
            {p.label}
          </Link>
        ))}
      </div>
      <form method="get" action={base} className="flex items-center gap-1.5 text-xs">
        <input type="date" name="from" defaultValue={from} aria-label="From date" className="rounded border border-border bg-background px-2 py-1 text-foreground" />
        <span className="text-muted-foreground">→</span>
        <input type="date" name="to" defaultValue={to} aria-label="To date" className="rounded border border-border bg-background px-2 py-1 text-foreground" />
        <button type="submit" className={chip(activeKey === "custom") + " cursor-pointer"}>
          Apply
        </button>
      </form>
    </div>
  );
}
