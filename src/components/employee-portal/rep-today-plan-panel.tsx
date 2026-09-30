import Link from "next/link";
import { Check, Plus } from "lucide-react";

import { PHOENIX_CRM_PORTAL_BASE, phoenixCrmModulePath } from "@/lib/phoenix-crm/modules";
import type { RepTodayPlan, RepTodayStop } from "@/lib/phoenix-crm/server/rep-landing";

/**
 * The rep's day on his LANDING page — what replaced the Phoenix CRM Today module.
 *
 * 🔴 THE OWNER'S OWN SPEC, 2026-09-30, retiring Today: "put the BRICKS as headers, if more than one
 * brick, and under each brick the customers planned to be visited today. When he has visited one it
 * is coloured GREEN; if not visited it is not coloured. And a very small plus sign that redirects him
 * to enter a visit for that person." — "of course not a big tool like this."
 *
 * So, deliberately, what is NOT here: no targets, no meters, no Next-up card, no route ordering, no
 * hours, no addresses. The Today module carried all of it and he retired it.
 *
 * The rules of this landing page it obeys (stated 2026-09-04, written out above the rep layout):
 *   - no decorative block, no empty tile, no prose;
 *   - square corners, written out — `--phx-radius` still defaults to 4px and is never inherited away;
 *   - 🔴 AM and PM are printed APART and never summed, which reaches this panel's counts too.
 *
 * A server component and plain links: no state, nothing to hydrate, and the browser's Back works.
 * Rendered only when there IS a day — `loadRepTodayPlan` answers null otherwise, so there is no
 * empty square here, which is the one thing he has sworn at on this page before.
 */

/** Where the "+" goes: the Visits module's own page, with the customer already chosen. */
function addVisitHref(stop: RepTodayStop): string {
  const path = phoenixCrmModulePath(PHOENIX_CRM_PORTAL_BASE, "visits");
  return `${path}?customer=${encodeURIComponent(stop.customerId)}&name=${encodeURIComponent(stop.name)}`;
}

function StopRow({ canAdd, stop }: { canAdd: boolean; stop: RepTodayStop }) {
  return (
    <li
      className={
        // GREEN once he has been; nothing at all when he has not. The tick carries it as well as the
        // colour, so it survives a screenshot in grey and a colour-blind reader.
        stop.done
          ? "flex min-w-0 items-center gap-2 border border-emerald-200 bg-emerald-50 px-2.5 py-2"
          : "flex min-w-0 items-center gap-2 border border-slate-200 bg-white px-2.5 py-2"
      }
    >
      {stop.done ? (
        <Check aria-hidden className="h-3.5 w-3.5 shrink-0 text-emerald-700" />
      ) : (
        <span aria-hidden className="h-3.5 w-3.5 shrink-0 border border-slate-300" />
      )}
      <span className="shrink-0 border border-slate-300 bg-slate-50 px-1 text-phx-2xs font-black uppercase tracking-[0.08em] text-slate-600">
        {stop.listType}
      </span>
      <span
        className={`min-w-0 flex-1 break-words text-phx-sm font-bold ${stop.done ? "text-emerald-900" : "text-slate-900"}`}
        dir="auto"
      >
        {stop.name}
      </span>
      {stop.done || !canAdd ? null : (
        // Very small, his word. 28px is still a comfortable tap and the row stays one line high.
        <Link
          aria-label={`Add a visit for ${stop.name}`}
          className="flex h-7 w-7 shrink-0 items-center justify-center border border-orange-300 bg-orange-50 text-orange-700 transition hover:border-orange-500 hover:bg-orange-100"
          href={addVisitHref(stop)}
        >
          <Plus aria-hidden className="h-4 w-4" />
        </Link>
      )}
    </li>
  );
}

export function RepTodayPlanPanel({ plan }: { plan: RepTodayPlan | null }) {
  if (!plan) return null;
  // Bricks as headers ONLY when there is more than one — his own condition. With a single brick the
  // header would name the only thing on the panel, twice.
  const showBrickHeaders = plan.bricks.length > 1;

  return (
    <section className="min-w-0 border border-slate-200 bg-white">
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-slate-100 px-3 py-2.5">
        <h2 className="min-w-0 break-words text-phx-xs font-black uppercase tracking-[0.1em] text-slate-500">Planned today</h2>
        {/* AM and PM apart, never a total (the call-rate golden rule). */}
        <p className="shrink-0 text-phx-xs font-bold tabular-nums text-slate-500">
          <span>
            {plan.amDone} of {plan.amPlanned} AM
          </span>
          <span aria-hidden> · </span>
          <span>
            {plan.pmDone} of {plan.pmPlanned} PM
          </span>
        </p>
      </div>
      <div className="grid min-w-0 gap-3 px-3 py-3">
        {plan.bricks.map((brick) => (
          <div className="grid min-w-0 gap-1.5" key={brick.key}>
            {showBrickHeaders ? (
              <h3 className="min-w-0 break-words text-phx-2xs font-black uppercase tracking-[0.1em] text-slate-400" dir="auto">
                {brick.label}
              </h3>
            ) : null}
            <ul className="grid min-w-0 gap-1.5">
              {brick.stops.map((stop) => (
                <StopRow canAdd={plan.canAdd} key={stop.customerId} stop={stop} />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
