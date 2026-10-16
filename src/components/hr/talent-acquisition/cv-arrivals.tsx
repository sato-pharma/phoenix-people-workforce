/**
 * CVs received today — the third panel he chose for her page on 2026-10-16 ("CVs received today").
 *
 * WHAT IT ANSWERS: "how much came in today, for which jobs, by which door, and how much of it has
 * nobody looked at yet". The Awaiting Review card above counts the whole backlog; this panel counts
 * ONE DAY, so a quiet backlog with a flood arriving this morning is visible as exactly that.
 *
 * THE SAME COUNT THE DAILY SUMMARY SENDS. The figures are `buildTodaysCvDigest` — the builder behind
 * the 18:00 CV summary — so the panel and that summary can never disagree about the same day.
 *
 * EVERY GROUP IS LISTED. The digest's own rule is that "Role not stated" and "Source not recorded"
 * are groups of their own rather than dropped, so the rows under each heading add up to the total;
 * this panel honours that and prints every group — no "and N more", which would be the ellipsis rule
 * broken in words. The bars compare the groups with each other (`breakdownBarPercent`, relative to
 * the largest), so the biggest role is a full bar and a single CV is still visibly a bar.
 *
 * THREE STATES. Loaded draws the panel; FAILED draws the amber notice inside it, never "0 CVs";
 * HIDDEN — a seat that may not read candidates — draws nothing at all, because telling somebody a
 * thing they were never allowed to see "could not load" is a lie of its own.
 */

import { Inbox, MailOpen } from "lucide-react";

import { breakdownBarPercent, type TalentCvToday } from "@/lib/hr/talent-acquisition-logic";
import type { DailyCvDigestGroup } from "@/lib/recruitment/inbound/daily-cv-digest";

import { TA_CAPS_CLASS, TaChip, TaCouldNotLoad, TaEmpty, TaPanel, TaQuietLink } from "./panel";

const SCREENING_HREF = "/hr/recruitment/screening";

/** One heading's breakdown: every group, its count, and a bar against the largest group. */
function Breakdown({ groups, label }: { groups: DailyCvDigestGroup[]; label: string }) {
  const largest = groups.reduce((max, group) => Math.max(max, group.count), 0);
  return (
    <div className="min-w-0">
      <p className={`${TA_CAPS_CLASS} mb-2 text-slate-500`}>{label}</p>
      <ul className="grid gap-2">
        {groups.map((group) => (
          <li className="min-w-0" key={group.label}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 break-words text-[12px] font-semibold leading-snug text-slate-700">
                {group.label}
              </span>
              <span className="shrink-0 text-[12px] font-black tabular-nums text-slate-900">
                {group.count.toLocaleString("en-US")}
              </span>
            </div>
            <div aria-hidden="true" className="mt-1 h-1 w-full bg-slate-100">
              <div
                className="h-full bg-[linear-gradient(90deg,#F97316_0%,#FB923C_100%)]"
                style={{ width: `${breakdownBarPercent(group.count, largest)}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function TaCvArrivals({ className = "", cvToday }: { className?: string; cvToday: TalentCvToday }) {
  if (cvToday.status === "hidden") return null;
  const digest = cvToday.status === "loaded" ? cvToday.digest : null;

  return (
    <TaPanel
      className={className}
      count={digest ? digest.total : null}
      href={SCREENING_HREF}
      hrefLabel="Open screening"
      icon={Inbox}
      id="ta-cvs-today"
      title="CVs received today"
    >
      {!digest ? (
        <TaCouldNotLoad what="Today's CVs" />
      ) : digest.total === 0 ? (
        <TaEmpty
          action={<TaQuietLink href={SCREENING_HREF}>Open the screening queue</TaQuietLink>}
          icon={MailOpen}
          line="Every CV that lands today is counted here, by the job it is for and the way it arrived."
          title="No CVs have arrived yet today"
        />
      ) : (
        <div className="flex flex-col gap-4 px-4 py-4">
          {/* The day in one line: the total, large, and how much of it is still unopened. */}
          <div className="flex flex-wrap items-end gap-x-4 gap-y-2 border-b border-slate-100 pb-4">
            <div>
              <p className="text-4xl font-black leading-none tabular-nums text-slate-900">
                {digest.total.toLocaleString("en-US")}
              </p>
              <p className={`${TA_CAPS_CLASS} mt-1.5 text-slate-500`}>
                {digest.total === 1 ? "CV arrived today" : "CVs arrived today"}
              </p>
            </div>
            <div className="pb-0.5">
              {digest.awaitingReview > 0 ? (
                <TaChip tone="amber">
                  {digest.awaitingReview.toLocaleString("en-US")} still waiting for a first look
                </TaChip>
              ) : (
                <TaChip tone="emerald">Every one has been looked at</TaChip>
              )}
            </div>
          </div>
          <div className="grid gap-5 @min-[520px]:grid-cols-2">
            <Breakdown groups={digest.byJobTitle} label="Applying for" />
            <Breakdown groups={digest.bySource} label="Arrived by" />
          </div>
        </div>
      )}
    </TaPanel>
  );
}
