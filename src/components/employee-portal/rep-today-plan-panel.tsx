import Link from "next/link";
import { Fragment } from "react";
import { Check, Plus } from "lucide-react";

import { DirectionsLink } from "@/components/phoenix-crm/directions-link";
import { gradeSpecialityParts } from "@/components/phoenix-crm/labels";
import { PHOENIX_CRM_PORTAL_BASE, phoenixCrmModulePath } from "@/lib/phoenix-crm/modules";
import type { RepTodayPlan, RepTodayBrick, RepTodayStop } from "@/lib/phoenix-crm/server/rep-landing";
import { adminControlDepthClassName, adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";

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
 * with it — no prose, and no round corners, which are never inherited and so are written out. AM, PM
 * and Pharmacies are printed APART, never summed. Nothing on it judges him (golden rule #1): no
 * distance, no reading, no check, no flag — only where he is going and whether he has been.
 */

/** Where the "+" goes: the Visits module's own page, with the customer already chosen. */
function addVisitHref(stop: RepTodayStop): string {
  const path = phoenixCrmModulePath(PHOENIX_CRM_PORTAL_BASE, "visits");
  return `${path}?customer=${encodeURIComponent(stop.customerId)}&name=${encodeURIComponent(stop.name)}`;
}

/**
 * AM, PM and Pharmacies each get their own chip — the same one "Needs you" puts in its header.
 *
 * 🔴 THREE FIGURES APART, never added together and never averaged. Two golden rules meet in this one
 * header: the call rate is scored AM against 2 and PM against 10, so a combined figure here would be
 * the first place that broke; and a pharmacy is counted APART from both, whatever the vendor tagged.
 *
 * `planned` is the denominator, and a pharmacy has none — it is feedback recorded ON a visit, so
 * there is nothing to plan against one. Left out, the chip reads "Pharmacies 2" instead of "n of m",
 * and it is never green: there is no figure for him to reach.
 */
function CountChip({ done, label, planned }: { done: number; label: string; planned?: number }) {
  // Nothing to say — nobody planned on that list, or no pharmacy visited yet. The panel carries no
  // empty square, and a bare "Pharmacies 0" on a day he has not reached one is exactly that.
  if (planned === 0 || (planned === undefined && done === 0)) return null;
  const complete = planned !== undefined && done >= planned;
  return (
    <span
      className={`border px-1.5 py-px text-phx-sm font-bold uppercase tracking-[0.06em] tabular-nums ${
        complete ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-slate-300 bg-white text-slate-600"
      }`}
    >
      {planned === undefined ? `${label} ${done}` : `${label} ${done} of ${planned}`}
    </span>
  );
}

/**
 * A line of parts joined by " · ", each part in a `<bdi>` of its own.
 *
 * 🔴 JOINED AS ONE STRING, AN ARABIC PART SCRAMBLES ITS NEIGHBOURS. The bidi rules lay a mixed line
 * out by its first letter, so "عيادة النور · 9:00 AM – 1:00 PM" read "AM – 1:00 PM 9:00 · عيادة النور"
 * on screen — the clock split from its AM. Isolated, every part keeps its own order, and the parts
 * run in the row's direction: place then hours, right to left under an Arabic name.
 */
function PartsLine({ className, parts }: { className: string; parts: readonly string[] }) {
  return (
    <span className={className}>
      {parts.map((part, index) => (
        <Fragment key={`${index}:${part}`}>
          {index > 0 ? " · " : null}
          <bdi>{part}</bdi>
        </Fragment>
      ))}
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
      <span className="w-6 shrink-0 text-phx-sm font-black uppercase tracking-[0.08em] text-slate-400">
        {stop.listType}
      </span>
      {/* 🔴 ONE DIRECTION FOR THE WHOLE BLOCK, TAKEN FROM THE NAME. `dir="auto"` sits here and on no
          line inside, so the name's first letter decides it: an Arabic name sets all three lines right
          to left, a Latin one left to right. Given a `dir` each, the lines zig-zagged — the Arabic
          name and place hugging the right edge, "Grade B" between them hugging the left. */}
      <span className="min-w-0 flex-1" dir="auto">
        <span
          className={`block break-words text-phx-md font-semibold leading-snug ${
            stop.done ? "text-emerald-900" : "text-slate-900"
          }`}
        >
          {stop.name}
        </span>
        {/* Who he is, then where and when — the grade and speciality on a line of their own (owner,
            2026-09-29, of the old CRM's dashboard: "with the specialities, with the grades").
            Semibold, as every Phoenix CRM screen prints this same line. */}
        <PartsLine
          className="mt-0.5 block break-words text-phx-xs font-semibold leading-snug text-slate-500"
          parts={gradeSpecialityParts(stop)}
        />
        <PartsLine className="mt-0.5 block break-words text-phx-xs leading-snug text-slate-500" parts={stop.where} />
        {/* The way to the place the line above names (owner, 2026-10-02) — one quiet line, in a new
            tab, and none at all when no place is saved. */}
        <DirectionsLink className="mt-1" customerName={stop.name} href={stop.directionsUrl} variant="text" />
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
          className={`ml-auto flex h-7 w-7 shrink-0 items-center justify-center border border-slate-300 bg-white text-slate-600 transition hover:border-orange-400 hover:bg-orange-50 hover:text-orange-800 ${adminControlDepthClassName}`}
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
      <span className="text-phx-sm font-bold uppercase tracking-[0.08em] text-slate-500">{brick.label}</span>
    </li>
  );
}

/**
 * A line under the stops: a small-caps label, then one figure per part — "This week  AM 10 planned ·
 * 6 visited", "Also today  AM 1  PM 2".
 *
 * ONE component for both, so the second line cannot drift from the first. Each part is its own
 * element and nothing joins or sums them (AM · PM · Pharmacies apart), and the row WRAPS rather than
 * scrolling, which is what the fits-the-screen golden rule asks for. No parts, no line at all — the
 * page's own rule is that it carries no empty tile.
 */
function FootLine({ label, parts }: { label: string; parts: readonly string[] }) {
  if (parts.length === 0) return null;
  return (
    <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-slate-200 bg-slate-50 px-3 py-2">
      <span className="text-phx-sm font-bold uppercase tracking-[0.08em] text-slate-500">{label}</span>
      {parts.map((part) => (
        <span className="break-words text-phx-xs font-semibold tabular-nums text-slate-600" key={part}>
          {part}
        </span>
      ))}
    </p>
  );
}

export function RepTodayPlanPanel({ plan }: { plan: RepTodayPlan | null }) {
  // NO EMPTY TILE (the page's own rule): no approved day, no panel.
  if (!plan) return null;
  // Bricks head the list ONLY when there is more than one — his own condition. With a single brick
  // the heading would name the only thing on the panel, twice.
  const showBrickHeadings = plan.bricks.length > 1;

  return (
    <section className={`min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
      {/*
        🔴 `flex-wrap` — the ONE place this header parts from the overview's, and the third chip is
        why (measured 2026-09-30 at 320px). The chip rail below is `shrink-0`, which makes its own
        `flex-wrap` inert — it is never handed a narrower width to wrap at — so three chips are 319px
        of content in a 284px header and the panel scrolls sideways, which the fits-the-screen golden
        rule forbids outright. Wrapping is the remedy that rule names, and it costs nothing anywhere
        else: at 360, 375, 390 and 412 the header measures identically with and without it, on one
        line, because the chips already fit there. Everything else is still the overview's, to the
        class, and `tests/phoenix-crm-today.test.ts` derives this string from that one.
      */}
      <header className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2">
        <h2 className="text-phx-xs font-bold uppercase tracking-[0.09em] text-slate-600">Your day</h2>
        <span className="min-w-0 break-words text-phx-sm font-semibold uppercase tracking-[0.08em] text-slate-400" dir="auto">
          {plan.soleBrick ? `${plan.dateLabel} · ${plan.soleBrick}` : plan.dateLabel}
        </span>
        <span className="ml-auto flex shrink-0 flex-wrap justify-end gap-1">
          <CountChip done={plan.amDone} label="AM" planned={plan.amPlanned} />
          <CountChip done={plan.pmDone} label="PM" planned={plan.pmPlanned} />
          <CountChip done={plan.pharmaciesDone} label="Pharmacies" />
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
      {/* 🔴 WHAT HE DID OFF THE PLAN, BESIDE IT (2026-10-02). The chips above count the plan's own
          stops — an off-plan visit used to be added into them, which turned "AM 3 of 2" green with a
          planned stop still undone. Apart, both figures are true, and the work he did off the plan
          is still on his screen. AM and PM each their own part, never summed. */}
      <FootLine label="Also today" parts={plan.alsoParts} />
      {/* 🔴 HIS OWN WEEK, ONE LINE (owner, 2026-10-02): his sent plan for the field week against what he
          has visited so far, AM · PM · Pharmacies APART like the chips above — each figure its own
          part, never added together. It wraps rather than scrolls (the fits-the-screen rule). */}
      <FootLine label="This week" parts={plan.weekParts} />
    </section>
  );
}
