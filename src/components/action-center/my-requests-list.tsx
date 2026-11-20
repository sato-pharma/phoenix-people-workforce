"use client";

import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import type { MyRequestItem, MyRequestStatusTone } from "@/components/action-center/types";
import { MY_REQUEST_MODULE_LABELS } from "@/components/action-center/types";
import { LANDING_INK, LandingRailLine, LandingTitle, landingActionClassName } from "@/components/employee-portal/landing-kit";

// The kit's language (landing-kit.tsx): a request's state is coloured small text on a thin rail at
// the row's left — never a filled pill. Returned takes the kit's own orange-700 tone.
const TONE_TEXT: Record<MyRequestStatusTone, string> = {
  pending: "text-amber-700",
  approved: "text-emerald-700",
  rejected: "text-rose-700",
  returned: "text-orange-700",
  neutral: "text-slate-600",
};

const TONE_RAIL: Record<MyRequestStatusTone, string> = {
  pending: "bg-amber-500",
  approved: "bg-emerald-500",
  rejected: "bg-rose-500",
  returned: "bg-orange-500",
  neutral: "bg-slate-300",
};

const PANEL = `min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName}`;

type Props = {
  initialId?: string | null;
  initialModule?: string | null;
  items: MyRequestItem[];
};

function matchesDeepLink(item: MyRequestItem, module: string | null | undefined, id: string | null | undefined) {
  if (!id) return false;
  return item.id === id || item.id === `${module ?? item.module}:${id}`;
}

/** A panel that states one condition: its title, then the words on a rail — never an empty square. */
function StatePanel({ title, rail, children }: { title: string; rail: string; children: React.ReactNode }) {
  return (
    <section className={PANEL}>
      <header className="border-b border-slate-200 px-3 py-2.5 sm:px-4">
        <LandingTitle>{title}</LandingTitle>
      </header>
      <LandingRailLine rail={rail}>{children}</LandingRailLine>
    </section>
  );
}

export function MyRequestsList({ initialId, initialModule, items }: Props) {
  const linkedItem = initialId ? items.find((item) => matchesDeepLink(item, initialModule, initialId)) ?? null : null;
  const orderedItems = linkedItem ? [linkedItem, ...items.filter((item) => item.id !== linkedItem.id)] : items;

  if (items.length === 0) {
    return (
      <StatePanel rail="bg-slate-300" title="No requests yet">
        Anything you submit — vacation, excuse, outstation, weekly plan, or resignation — shows here with its live approval status.
      </StatePanel>
    );
  }

  if (initialId && !linkedItem) {
    return (
      <StatePanel rail="bg-amber-500" title="Request not found">
        The request from this notification is not available in your current Action Center view.
      </StatePanel>
    );
  }

  return (
    <div className={`divide-y divide-slate-200 ${PANEL}`}>
      {orderedItems.map((item) => {
        const linked = linkedItem?.id === item.id;
        return (
          <div
            key={item.id}
            className={`flex min-w-0 gap-3 px-3 py-3.5 sm:px-4 ${linked ? "bg-slate-50" : ""}`}
          >
            {/* The request a notification opened is marked by a navy rail; every other row's rail
                carries its state. */}
            <span aria-hidden="true" className={`w-1 shrink-0 self-stretch ${linked ? "bg-[#08111f]" : TONE_RAIL[item.statusTone]}`} />
            <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-phx-xs font-bold uppercase tracking-[0.1em]">
                  <span className="text-slate-500">{MY_REQUEST_MODULE_LABELS[item.module]}</span>
                  <span aria-hidden="true" className="text-slate-300">·</span>
                  <span className={TONE_TEXT[item.statusTone]}>{item.statusLabel}</span>
                </div>
                <p className={`break-words text-sm font-bold ${LANDING_INK}`} dir="auto">{item.title}</p>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-slate-500">
                  {item.lines.map((line) => (
                    <span className="min-w-0 break-words" dir="auto" key={line.label}>
                      <span className="font-semibold text-slate-600">{line.label}:</span> {line.value}
                    </span>
                  ))}
                </div>
                {item.decisionNote && (
                  <p className="mt-1.5 whitespace-pre-line break-words border-l-2 border-slate-300 py-1 pl-2.5 text-phx-xs italic text-slate-600" dir="auto">
                    &ldquo;{item.decisionNote}&rdquo;
                  </p>
                )}
                {item.href && (
                  <a className={landingActionClassName("outline", "mt-2")} href={item.href}>
                    Open request
                  </a>
                )}
              </div>
              <div className="shrink-0 text-phx-xs font-medium tabular-nums text-slate-500">
                {new Date(item.submittedAt).toLocaleDateString("en", { day: "2-digit", month: "short", year: "numeric" })}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
