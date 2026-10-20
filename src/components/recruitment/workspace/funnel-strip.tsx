// Recruitment workspace — the funnel in each tab's header (owner, 20 Oct 2026): received →
// shortlisted → sent to manager → interviewed → offered → hired, for the tab and place in view.
//
// It wraps rather than scrolls on a phone, and each step says what share of the received it kept,
// because "12" means nothing until you know it was 12 of 140. The six tiles are one ruled strip, drawn
// with the table's own hairlines: three to a row in a narrow column, six in one line from 720px of the
// column's OWN width (it sits in the half page beside an opened CV).

import { adminRecessedDepthClassName } from "@/components/admin/admin-design-tokens";
import type { WorkspaceFunnel } from "@/lib/recruitment/workspace/types";
import { cn } from "@/lib/utils";

const STEPS: ReadonlyArray<{ key: keyof WorkspaceFunnel; label: string }> = [
  { key: "received", label: "Received" },
  { key: "shortlisted", label: "Shortlisted" },
  { key: "sent_to_manager", label: "Sent to manager" },
  { key: "interviewed", label: "Interviewed" },
  { key: "offered", label: "Offered" },
  { key: "hired", label: "Hired" },
];

const NUMBER = new Intl.NumberFormat("en-US");

export function FunnelStrip({ funnel, unavailable = false }: { funnel: WorkspaceFunnel | null; unavailable?: boolean }) {
  const received = funnel?.received ?? 0;
  return (
    <div
      aria-label="Hiring funnel"
      className={`grid grid-cols-3 gap-px border border-slate-200 bg-slate-200 @min-[720px]:grid-cols-6 ${adminRecessedDepthClassName}`}
    >
      {STEPS.map((step, index) => {
        const value = funnel ? funnel[step.key] : null;
        const share = value !== null && received > 0 && index > 0 ? Math.round((value / received) * 100) : null;
        return (
          <div className={cn("min-w-0 px-3 py-2", index === 0 ? "bg-slate-50" : "bg-white")} key={step.key}>
            <p className="break-words text-phx-xs font-black uppercase tracking-wide text-slate-500">{step.label}</p>
            <p className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5">
              <span className={cn("text-lg font-black tabular-nums tracking-tight", index === 0 ? "text-slate-950" : "text-orange-700")}>
                {unavailable || value === null ? "—" : NUMBER.format(value)}
              </span>
              {share !== null ? <span className="text-phx-xs font-bold tabular-nums text-slate-500">{`${share}% of received`}</span> : null}
            </p>
          </div>
        );
      })}
    </div>
  );
}
