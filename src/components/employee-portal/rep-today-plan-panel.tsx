import Link from "next/link";
import { Check, Plus } from "lucide-react";

import { PHOENIX_CRM_PORTAL_BASE, phoenixCrmModulePath } from "@/lib/phoenix-crm/modules";
import type { RepTodayPlan, RepTodayBrick, RepTodayStop } from "@/lib/phoenix-crm/server/rep-landing";

/**
 * The rep's day on his OVERVIEW — what replaced the Phoenix CRM Today module.
 *
 * 🔴 THE OWNER'S SPEC, 2026-09-30, retiring Today: "put the BRICKS as headers, if more than one
 * brick, and under each brick the customers planned to be visited today. When he has visited one it
 * is coloured GREEN; if not visited it is not coloured. And a very small plus sign that redirects him
 * to enter a visit for that person." — "of course not a big tool like this."
 *
 * 🔴 AND THEN, ON SEEING THE FIRST ATTEMPT: "it became AWFUL like this. Find a way to put it to be
 * CONTRASTING and PREMIUM POLISHED with the current overview. I recommend that you remove the Early
 * Birds and the My Tools, and put the doctors in a premium polished, in their place." So it is not a
 * look of its own invention dropped above the tiles: it TAKES the right-hand column those two held,
 * and every piece of it is borrowed from the panels it now sits beside —
 *
 *   · the panel chrome is `RepPanel`'s, to the class;
 *   · the header counts are the "N open" chip from "Needs you";
 *   · the rows are `RepNeedRow`'s — a `w-1 self-stretch` rail, the name, a small meta line, a CTA
 *     on the right edge;
 *   · the "+" wears the same bordered, orange-on-hover CTA as "Track" and "Open".
 *
 * That is the whole answer to "contrasting and premium polished WITH the current overview": it reads
 * as the fourth panel of a set, and the only thing that contrasts is the green.
 *
 * WHY THE CHROME IS WRITTEN OUT HERE rather than imported: `RepPanel`, `RepNeedRow` and the chip all
 * live in portal-command-center.tsx, which imports THIS file — taking them from there would be a
 * cycle. `tests/phoenix-crm-today.test.ts` compares the two files so they cannot drift apart.
 *
 * The page's own rules it obeys (stated 2026-09-04 above the rep layout): no decorative block, NO
 * EMPTY TILE — it renders nothing at all when there is no approved day, and the column collapses
 * with it — no prose, and no round corners, which are never inherited and so are written out. AM and
 * PM are printed APART, never summed. Nothing on it judges him (golden rule #1): no distance, no
 * reading, no check, no flag — only where he is going and whether he has been.
 */

/** Where the "+" goes: the Visits module's own page, with the customer already chosen. */
function addVisitHref(stop: RepTodayStop): string {
  const path = phoenixCrmModulePath(PHOENIX_CRM_PORTAL_BASE, "visits");
  return `${path}?customer=${encodeURIComponent(stop.customerId)}&name=${encodeURIComponent(stop.name)}`;
}

/**
 * AM and PM each get their own chip — the same one "Needs you" puts in its header. 🔴 They are never
 * added together and never averaged: the call-rate golden rule (AM against 2, PM against 10) reaches
 * every count of a day, and one combined figure here would be the first place it broke.
 */
function CountChip({ done, label, planned }: { done: number; label: string; planned: number }) {
  if (planned === 0) return null;
  const complete = done >= planned;
  return (
    <span
      className={`border px-1.5 py-px text-phx-2xs font-bold uppercase tracking-[0.06em] tabular-nums ${
        complete ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-slate-300 bg-white text-slate-600"
      }`}
    >
      {label} {done} of {planned}
    </span>
  );
}

/**
 * One customer, in `RepNeedRow`'s shape.
 *
 * Visited is GREEN — an emerald rail, a tinted row and a tick where the "+" was — so it still reads
 * in a grey screenshot and to someone who cannot see the colour. One not visited carries NO colour at
 * all, which is his own wording: its rail is the neutral slate that keeps the rows aligned.
 */
function StopRow({ canAdd, stop }: { canAdd: boolean; stop: RepTodayStop }) {
  return (
    <li
      className={`flex items-center gap-3 border-b border-slate-200 px-3 py-2 last:border-b-0 ${
        stop.done ? "bg-emerald-50" : "bg-white"
      }`}
    >
      <span aria-hidden="true" className={`w-1 self-stretch ${stop.done ? "bg-emerald-500" : "bg-slate-200"}`} />
      <span className="w-6 shrink-0 text-phx-2xs font-black uppercase tracking-[0.08em] text-slate-400">
        {stop.listType}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={`block break-words text-phx-md font-semibold leading-snug ${
            stop.done ? "text-emerald-900" : "text-slate-900"
          }`}
          dir="auto"
        >
          {stop.name}
        </span>
        <span className="mt-0.5 block break-words text-phx-xs leading-snug text-slate-500" dir="auto">
          {stop.where}
        </span>
      </span>
      {stop.done ? (
        <span
          aria-label="Visited"
          className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center border border-emerald-300 bg-emerald-50 text-emerald-700"
        >
          <Check aria-hidden="true" className="h-4 w-4" />
        </span>
      ) : canAdd ? (
        // Very small, his word — and the same bordered, orange-on-hover CTA the other panels' rows
        // end with, so the column's right edge keeps one rhythm.
        <Link
          aria-label={`Add a visit for ${stop.name}`}
          className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center border border-slate-300 bg-white text-slate-600 transition hover:border-orange-400 hover:bg-orange-50 hover:text-orange-800"
          href={addVisitHref(stop)}
        >
          <Plus aria-hidden="true" className="h-4 w-4" />
        </Link>
      ) : null}
    </li>
  );
}

/** A brick's name, in the panel header's own small-caps — shown only when there is more than one. */
function BrickHeading({ brick }: { brick: RepTodayBrick }) {
  return (
    <li className="border-b border-slate-200 bg-slate-50 px-3 py-1" dir="auto">
      <span className="text-phx-2xs font-bold uppercase tracking-[0.08em] text-slate-500">{brick.label}</span>
    </li>
  );
}

export function RepTodayPlanPanel({ plan }: { plan: RepTodayPlan | null }) {
  // NO EMPTY TILE (the page's own rule): no approved day, no panel.
  if (!plan) return null;
  // Bricks head the list ONLY when there is more than one — his own condition. With a single brick
  // the heading would name the only thing on the panel, twice.
  const showBrickHeadings = plan.bricks.length > 1;

  return (
    <section className="min-w-0 border border-slate-200 bg-white">
      <header className="flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2">
        <h2 className="text-phx-xs font-bold uppercase tracking-[0.09em] text-slate-600">Your day</h2>
        <span className="min-w-0 break-words text-phx-2xs font-semibold uppercase tracking-[0.08em] text-slate-400" dir="auto">
          {plan.soleBrick ? `${plan.dateLabel} · ${plan.soleBrick}` : plan.dateLabel}
        </span>
        <span className="ml-auto flex shrink-0 flex-wrap justify-end gap-1">
          <CountChip done={plan.amDone} label="AM" planned={plan.amPlanned} />
          <CountChip done={plan.pmDone} label="PM" planned={plan.pmPlanned} />
        </span>
      </header>
      <ul className="min-w-0">
        {plan.bricks.map((brick) => (
          <li className="min-w-0" key={brick.key}>
            <ul className="min-w-0">
              {showBrickHeadings ? <BrickHeading brick={brick} /> : null}
              {brick.stops.map((stop) => (
                <StopRow canAdd={plan.canAdd} key={stop.customerId} stop={stop} />
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}
