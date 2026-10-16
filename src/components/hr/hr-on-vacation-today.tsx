/**
 * "On a vacation today" — the HR command centre's absence panel.
 *
 * WHY IT EXISTS. Owner instruction, 2026-09-29: "make on her landing page appear on a vacation
 * today." HR Operations administers attendance and leave, and the question that seat has every
 * morning — who is not at work today — was answerable only by opening the Vacation Report and
 * filtering it. A fact you have to assemble is a fact nobody checks.
 *
 * NAMES, NOT A COUNT (owner's standing rule). The headline carries the number because that is what
 * is read at a glance, but the panel's substance is the list of people, each with the reason and
 * how long they are away, each a link to the request behind it. A tile reading "On Vacation Today
 * 4" would have answered the wrong question — and the owner's verdict on this page's first version
 * was that it had "too many key codes", so this deliberately adds no tile.
 *
 * EMPTY RENDERS, AND SAYS SO IN WORDS. "Nobody is on a vacation today" is a real, useful answer and
 * the rule for this page type is "relevant even if empty". What must NEVER render is that sentence
 * when the source failed — so the panel draws nothing at all for a null list, and the page's
 * `unavailableSources` notice names it instead. See the note on `HrCommandCenterData.onVacationToday`.
 *
 * NO `"use client"`, AND NO HOOKS — the same as its sibling `hr-my-record.tsx`. The surrounding page
 * IS a client component, so this file is compiled into its bundle either way; what the missing
 * directive records is that nothing here needs it. Nothing collapses, nothing filters, and the rows
 * arrive already shaped from the server. Adding view state to this panel means adding the directive
 * deliberately, not inheriting it.
 *
 * NO DATE IS PRINTED IN THE HEADING. "Today" is resolved on the SERVER as a Cairo day; rendering
 * that date here would invite a formatter that reads the browser's clock instead, which is how a
 * panel ends up disagreeing with the rows it is drawing. The rows carry their own real dates.
 *
 * SQUARE EDGES (owner's golden rule — no round or semi-round corners, anywhere). The sibling panel
 * `hr-today-panel.tsx` still carries a `rounded-xl` badge and a `rounded-full` dot from before that
 * rule was enforced; this file matches its type scale, tones, spacing and orange accent exactly and
 * does NOT copy its radii. Matching a sibling's identity never extends to copying a locked-rule
 * violation out of it.
 *
 * NEVER A HORIZONTAL SCROLL, AND NEVER AN ELLIPSIS (both owner's golden rules). No table, no
 * `min-width`, no `overflow-x-auto`: every row is `flex-wrap`, every value `break-words`, and the
 * name, reason and duration stack onto their own lines at 375px rather than sitting behind a
 * sideways drag.
 */

import { ArrowUpRight, Plane } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import type { OnVacationTodayRow } from "@/lib/vacation/on-vacation-today";

/** The seat's own Vacation Report — the row the HR Operations sidebar actually offers her. */
const REPORT_HREF = "/hr/leave-management/vacation-report";

/**
 * `linked` is TRUE for the seat the Vacation Report opens for (HR Operations) and FALSE for the
 * Talent Acquisition seat (owner, 2026-10-16, option "hide the link and the row links, keep the
 * panel"). Her panel reads the company's approved absences through her Workforce Context function,
 * but the report it would link to scopes her to her OWN leave, so the button and every row link
 * landed her on a page that could not show the person named above it. The names stay; the links go.
 */
export function HrOnVacationToday({
  linked = true,
  rows,
}: {
  linked?: boolean;
  rows: OnVacationTodayRow[] | null;
}) {
  // The source did not answer. Drawing "nobody is on a vacation today" here would be the
  // misleading zero — see the header.
  if (rows === null) return null;

  const count = rows.length;

  return (
    <section className="border-b border-slate-200/70 bg-white">
      <div className="px-4 py-5 sm:px-6">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="h-2 w-2 shrink-0 bg-gradient-to-r from-orange-500 to-amber-400 shadow-[0_0_8px_rgba(249,115,22,0.5)]" />
          <h2 className="whitespace-nowrap text-[11px] font-black uppercase tracking-[0.16em] text-slate-950">
            On a vacation today
          </h2>
          <span className="whitespace-nowrap text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">
            Approved leave only
          </span>
        </div>
        <p
          className={`mt-2.5 break-words text-[15px] font-bold leading-6 ${
            count === 0 ? "text-emerald-700" : "text-slate-900"
          }`}
        >
          {count === 0
            ? "Nobody is on a vacation today."
            : `${count.toLocaleString("en-US")} ${count === 1 ? "person is" : "people are"} on a vacation today.`}
        </p>
      </div>

      {count === 0 ? null : (
        <ul className="divide-y divide-slate-200/70 border-t border-slate-200/70">
          {rows.map((row) => (
            <li key={row.id}>
              <RowShell href={linked ? row.href : null}>
                <Plane
                  aria-hidden="true"
                  className="h-3.5 w-3.5 shrink-0 self-center text-slate-400"
                />
                <span className="break-words text-[12.5px] font-bold leading-snug text-slate-900">
                  {row.name}
                </span>
                {row.meta ? (
                  <span className="break-words text-[11px] font-medium leading-snug text-slate-500">
                    {row.meta}
                  </span>
                ) : null}
                <span className="whitespace-nowrap border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600">
                  {row.typeLabel}
                </span>
                {/* Only when it is not a whole day — printing "Full day" on every row would be
                    noise, and its absence is what makes a half day stand out. */}
                {row.dayPartLabel === "Full day" ? null : (
                  <span className="whitespace-nowrap border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] text-amber-800">
                    {row.dayPartLabel}
                  </span>
                )}
                <span className="ml-auto whitespace-nowrap text-[10px] font-black uppercase tracking-[0.1em] text-slate-400">
                  {row.untilLabel}
                </span>
                {linked ? (
                  <ArrowUpRight
                    aria-hidden="true"
                    className="h-3.5 w-3.5 shrink-0 self-center text-orange-400 opacity-0 transition-opacity duration-150 group-hover/row:opacity-100"
                  />
                ) : null}
              </RowShell>
            </li>
          ))}
        </ul>
      )}

      {linked ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-slate-200/70 px-4 py-3 sm:px-6">
          <Link
            className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] font-black uppercase tracking-[0.1em] text-orange-600 transition-colors hover:text-orange-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
            href={REPORT_HREF}
          >
            Open the Vacation Report
            <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5" />
          </Link>
        </div>
      ) : null}
    </section>
  );
}

/** One absence row: a link to its request, or the same row with no link when the seat cannot open it. */
function RowShell({ children, href }: { children: ReactNode; href: string | null }) {
  if (href === null) {
    return (
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3 sm:px-6">{children}</div>
    );
  }
  return (
    <Link
      className="group/row flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3 transition-colors duration-150 hover:bg-slate-50/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-orange-500 sm:px-6"
      href={href}
    >
      {children}
    </Link>
  );
}
