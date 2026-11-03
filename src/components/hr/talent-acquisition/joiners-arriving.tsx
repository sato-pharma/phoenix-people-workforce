/**
 * Joiners arriving in the next fourteen days — the second panel he chose for her page on 2026-10-16.
 *
 * WHAT IT ANSWERS: "who walks in soon, and is everything ready for them". The month grid marks a
 * joining day as a dot on a date; this panel is the same people as a list, nearest first, with how
 * many days are left — the number that decides whether the paperwork, the account and the seat are
 * a today job or a next-week job.
 *
 * ONLY AN ACCEPTED OFFER IS SOMEBODY ARRIVING. The rows are `joinersBetween` over the offers the page
 * already loaded — the same rule the month grid draws its joining days with — so a sent letter with
 * a proposed start date never appears here. A row leads to the Job Offers list (the page takes no
 * `?open=<id>`, so a row never pretended to open one offer), and once the offer has an employee record
 * the day is that record's hire date.
 *
 * A FAILED READ IS SAID. The offers not loading draws the amber notice, never "nobody is joining".
 */

import { CalendarCheck2, UserPlus, type LucideIcon } from "lucide-react";
import Link from "next/link";

import {
  dateBlockParts,
  daysBetweenKeys,
  daysUntilLabel,
  type TalentJoiners,
} from "@/lib/hr/talent-acquisition-logic";

import { TA_ROW_LINK_CLASS, TaChip, TaCouldNotLoad, TaEmpty, TaPanel, TaQuietLink } from "./panel";

const OFFERS_HREF = "/hr/offers";

/** "16 Oct" — a short date for the panel's span, from the key alone. */
function shortDate(dateKey: string): string {
  const parts = dateBlockParts(dateKey);
  return `${parts.day} ${parts.month}`;
}

export function TaJoinersArriving({
  className = "",
  joiners,
}: {
  className?: string;
  joiners: TalentJoiners;
}) {
  return (
    <TaDatedPeople
      className={className}
      couldNotLoad="The offers"
      emptyAction="See every offer"
      emptyIcon={CalendarCheck2}
      emptyLine="No accepted offer starts in the next fourteen days."
      emptyTitle="Nobody is due to join"
      footerNote="accepted offers only"
      href={OFFERS_HREF}
      hrefLabel="Open offers"
      icon={UserPlus}
      id="ta-joiners-arriving"
      people={joiners}
      title="Joiners arriving"
      verb="joins"
    />
  );
}

/**
 * The same list for any people on a date: the HR Operations Specialist's joiners, read from Hiring
 * Documents, and the people leaving, read from Resignations. One row design, so her page and this
 * one can never drift apart.
 */
export function TaDatedPeople({
  className = "",
  couldNotLoad,
  emptyAction,
  emptyIcon,
  emptyLine,
  emptyTitle,
  footerNote,
  href,
  hrefLabel,
  icon,
  id,
  people: joiners,
  title,
  verb,
}: {
  className?: string;
  /** Named in the amber notice when the read failed, as "<what> could not be loaded". */
  couldNotLoad: string;
  emptyAction: string;
  emptyIcon: LucideIcon;
  emptyLine: string;
  emptyTitle: string;
  footerNote: string;
  href: string;
  hrefLabel: string;
  icon: LucideIcon;
  id: string;
  people: TalentJoiners;
  title: string;
  /** Spoken in each row's accessible name: "Sara, Accountant, joins tomorrow". */
  verb: string;
}) {
  const rows = [...joiners.rows].sort(
    (left, right) => left.dateKey.localeCompare(right.dateKey) || left.name.localeCompare(right.name),
  );
  const thisWeek = rows.filter((row) => daysBetweenKeys(joiners.fromKey, row.dateKey) <= 6).length;

  return (
    <TaPanel
      className={className}
      count={joiners.loaded ? rows.length : null}
      footer={
        joiners.loaded && rows.length > 0 ? (
          <span>
            <span className="font-black tabular-nums text-slate-700">{thisWeek}</span> within the next seven
            days
            <span aria-hidden="true" className="px-1.5 text-slate-300">
              ·
            </span>
            {footerNote}
          </span>
        ) : undefined
      }
      href={href}
      hrefLabel={hrefLabel}
      icon={icon}
      id={id}
      subtitle={`${shortDate(joiners.fromKey)} – ${shortDate(joiners.toKey)}`}
      title={title}
    >
      {!joiners.loaded ? (
        <TaCouldNotLoad what={couldNotLoad} />
      ) : rows.length === 0 ? (
        <TaEmpty
          action={<TaQuietLink href={href}>{emptyAction}</TaQuietLink>}
          icon={emptyIcon}
          line={emptyLine}
          title={emptyTitle}
        />
      ) : (
        <ol className="divide-y divide-slate-100">
          {rows.map((row) => {
            const block = dateBlockParts(row.dateKey);
            const days = daysBetweenKeys(joiners.fromKey, row.dateKey);
            const soon = days <= 1;
            return (
              <li key={row.id}>
                <Link
                  aria-label={`${row.name}, ${row.title}, ${verb} ${daysUntilLabel(joiners.fromKey, row.dateKey)}`}
                  className={`${TA_ROW_LINK_CLASS} items-center`}
                  href={row.href}
                >
                  {/* The date block: weekday, day, month — a calendar leaf, square, the day the
                      largest thing on the row because the day is what she plans around. */}
                  <span
                    aria-hidden="true"
                    className={`flex w-11 shrink-0 flex-col items-center border py-1 ${
                      soon
                        ? "border-orange-300 bg-[linear-gradient(180deg,#FFF7ED_0%,#FFEDD5_100%)] shadow-[0_4px_10px_rgba(249,115,22,0.15)]"
                        : "border-slate-200 bg-[linear-gradient(180deg,#FFFFFF_0%,#F7F9FC_100%)]"
                    }`}
                  >
                    <span
                      className={`text-[10px] font-black uppercase tracking-[0.1em] ${soon ? "text-orange-700" : "text-slate-500"}`}
                    >
                      {block.weekday}
                    </span>
                    <span
                      className={`text-[17px] font-black leading-none tabular-nums ${soon ? "text-orange-700" : "text-slate-900"}`}
                    >
                      {block.day}
                    </span>
                    <span
                      className={`text-[10px] font-black uppercase tracking-[0.1em] ${soon ? "text-orange-700" : "text-slate-500"}`}
                    >
                      {block.month}
                    </span>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className="block break-words text-[13px] font-bold leading-snug text-slate-900 group-hover/row:text-orange-800"
                      dir="auto"
                    >
                      {row.name}
                    </span>
                    <span className="mt-0.5 block break-words text-[11px] font-semibold text-slate-500">
                      {row.title}
                    </span>
                  </span>
                  <TaChip tone={soon ? "orange" : "slate"}>{daysUntilLabel(joiners.fromKey, row.dateKey)}</TaChip>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </TaPanel>
  );
}
