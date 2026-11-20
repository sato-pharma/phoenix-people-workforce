"use client";

// "My interviews" — the signed-in person's own upcoming interviews on the portal home, and a
// one-time "Add to your calendar" link so they show up in Outlook / Google / the phone too. The
// owner, 2026-09-26: make the interview calendar relevant to everyone daily. It travels inside the
// identity band, so it lands on every role's home in one place, and renders NOTHING when the person
// has no interviews coming up — most people never see it.
//
// It wears the landing kit's white panel (landing-kit.tsx, the owner's 2026-11-20 redesign): the tick
// title with the count beside it, one row per interview led by its day as a navy stamp, and the
// calendar subscription in the panel's foot. No icon sits in a filled square and nothing is cut — a
// long candidate name wraps inside its own row on a 280px phone.

import { Building2, CalendarPlus, Check, ChevronRight, Copy, Loader2, Phone, Video } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import type { PortalMyInterview } from "@/lib/employee-portal/home-snapshot";
import { PLATFORM_LABEL } from "@/lib/recruitment/interview-calendar-types";
import { formatDayLong, formatShortDate, formatTimeRange, weekdayShort } from "@/lib/recruitment/interview-calendar-week";
import { phxFieldClassName } from "@/components/ui/form-tokens";
import { LandingMeta, LandingPanel, landingActionClassName } from "@/components/employee-portal/landing-kit";
import { cn } from "@/lib/utils";

/**
 * The kit's button shape (LandingCta) for the actions here that are buttons, not links: the kit draws
 * its call to action as a <Link>, and these run on the page. Same frame, same type, 40px on a phone.
 */

export function MyInterviewsCard({ interviews }: { interviews: PortalMyInterview[] }) {
  const [feedUrl, setFeedUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (interviews.length === 0) return null;

  async function addToCalendar() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/recruitment/interview-calendar/my-calendar-feed", { cache: "no-store" });
      const data = (await response.json().catch(() => ({}))) as { path?: string; message?: string };
      if (!response.ok || !data.path) throw new Error(typeof data.message === "string" ? data.message : "Could not make your calendar link.");
      setFeedUrl(`${window.location.origin}${data.path}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not make your calendar link.");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!feedUrl) return;
    try {
      await navigator.clipboard.writeText(feedUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Copy did not work — select the link and copy it by hand.");
    }
  }

  const webcalUrl = feedUrl ? feedUrl.replace(/^https?:/, "webcal:") : null;

  return (
    <LandingPanel right={<LandingMeta items={[`${interviews.length} coming up`]} />} title="Your interviews">
      <ul>
        {interviews.map((interview) => {
          const [day, month] = formatShortDate(interview.dateKey).split(" ");
          const PlatformIcon = interview.platform === "zoom" ? Video : interview.platform === "phone" ? Phone : Building2;
          return (
            <li className="border-b border-slate-200 last:border-b-0" key={interview.id}>
              <Link
                className="group flex min-w-0 items-center gap-3 px-3 py-3 transition-colors hover:bg-slate-50 sm:px-4"
                href={`/employee-portals/interview-calendar?open=${encodeURIComponent(interview.id)}`}
              >
                {/* The day as a stamp — weekday, date, month — so a week of interviews reads down the
                    left edge at a glance. Screen readers get the whole date in words instead. */}
                <span aria-hidden="true" className="flex w-12 shrink-0 flex-col items-center border-r border-slate-200 pr-3 text-center">
                  <span className="text-phx-xs font-bold uppercase tracking-[0.08em] text-slate-500">{weekdayShort(interview.dateKey)}</span>
                  <span className="mt-1 text-[22px] font-bold leading-none tracking-[-0.02em] tabular-nums text-[#08111f]">{day}</span>
                  <span className="mt-1 text-phx-xs font-bold uppercase tracking-[0.08em] text-slate-500">{month}</span>
                </span>
                <span className="min-w-0 flex-1">
                  <span className="sr-only">{formatDayLong(interview.dateKey)}: </span>
                  <span className="block break-words text-phx-md font-bold leading-snug text-[#08111f]" dir="auto">
                    {interview.candidateName}
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-phx-xs font-semibold tabular-nums text-slate-500">
                    <span>{formatTimeRange(interview.startMinutes, interview.durationMinutes)}</span>
                    <span aria-hidden="true" className="text-slate-300">
                      ·
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <PlatformIcon aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                      {PLATFORM_LABEL[interview.platform]}
                    </span>
                  </span>
                </span>
                <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-slate-300 transition-colors group-hover:text-[#08111f]" />
              </Link>
            </li>
          );
        })}
      </ul>

      <div className="border-t border-slate-200 px-3 py-3 sm:px-4">
        {feedUrl ? (
          <div className="space-y-2.5">
            <p className="break-words text-phx-sm leading-snug text-slate-600">
              Subscribe once and your interviews stay in your calendar, refreshing on their own. Add this link in Outlook, Google Calendar or your phone as a subscribed calendar (not an import).
            </p>
            {/* The field takes the row; under 12rem it gives the two buttons a line of their own
                rather than shrinking to nothing beside them on a narrow phone. */}
            <div className="flex flex-wrap items-center gap-2">
              <input
                aria-label="Your calendar subscription link"
                className={cn(phxFieldClassName, "min-w-0 grow basis-48")}
                readOnly
                value={feedUrl}
                onFocus={(event) => event.currentTarget.select()}
              />
              <button className={landingActionClassName("outline", "sm:min-h-10")} onClick={() => void copy()} type="button">
                {copied ? <Check aria-hidden="true" className="h-3.5 w-3.5 text-emerald-600" /> : <Copy aria-hidden="true" className="h-3.5 w-3.5" />}
                {copied ? "Copied" : "Copy"}
              </button>
              {webcalUrl ? (
                <a className={landingActionClassName("solid", "sm:min-h-10")} href={webcalUrl}>
                  <CalendarPlus aria-hidden="true" className="h-3.5 w-3.5" />
                  Subscribe
                </a>
              ) : null}
            </div>
          </div>
        ) : (
          <button className={landingActionClassName("outline")} disabled={busy} onClick={() => void addToCalendar()} type="button">
            {busy ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> : <CalendarPlus aria-hidden="true" className="h-3.5 w-3.5" />}
            Add these to your own calendar
          </button>
        )}
        {error ? <p className="mt-2 break-words text-phx-sm font-semibold text-rose-700">{error}</p> : null}
      </div>
    </LandingPanel>
  );
}
