// Recruitment workspace — the funnel in each tab's header (owner, 20 Oct 2026): received →
// shortlisted → sent to manager → interviewed → offered → hired, for the tab and place in view.
//
// It wraps rather than scrolls on a phone, and each step says what share of the received it kept,
// because "12" means nothing until you know it was 12 of 140.

import { ChevronRight } from "lucide-react";
import { Fragment } from "react";

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
      className={`flex flex-wrap items-stretch gap-1 border border-slate-200 bg-slate-50/80 p-1.5 ${adminRecessedDepthClassName}`}
    >
      {STEPS.map((step, index) => {
        const value = funnel ? funnel[step.key] : null;
        const share = value !== null && received > 0 && index > 0 ? Math.round((value / received) * 100) : null;
        return (
          <Fragment key={step.key}>
            {index > 0 ? (
              <span aria-hidden className="hidden items-center text-slate-300 sm:flex">
                <ChevronRight className="h-4 w-4" />
              </span>
            ) : null}
            <div className="min-w-[6.5rem] grow basis-[6.5rem] bg-white px-2.5 py-1.5 sm:grow-0">
              <p className="text-phx-xs font-black uppercase tracking-wide text-slate-500">{step.label}</p>
              <p className="mt-0.5 flex items-baseline gap-1.5">
                <span className={cn("text-lg font-black tabular-nums tracking-tight", index === 0 ? "text-slate-950" : "text-orange-700")}>
                  {unavailable || value === null ? "—" : NUMBER.format(value)}
                </span>
                {share !== null ? <span className="text-phx-xs font-bold tabular-nums text-slate-500">{share}%</span> : null}
              </p>
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}
