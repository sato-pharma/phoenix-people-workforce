"use client";

// "My interviews" — the signed-in person's own upcoming interviews on the portal home, and a
// one-time "Add to your calendar" link so they show up in Outlook / Google / the phone too. The
// owner, 2026-09-26: make the interview calendar relevant to everyone daily. It travels inside the
// identity band, so it lands on every role's home in one place, and renders NOTHING when the person
// has no interviews coming up — most people never see it.

import { Building2, CalendarClock, CalendarPlus, Check, Copy, Loader2, Phone, Video } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import type { PortalMyInterview } from "@/lib/employee-portal/home-snapshot";
import { PLATFORM_LABEL } from "@/lib/recruitment/interview-calendar-types";
import { formatDayLong, formatTimeRange } from "@/lib/recruitment/interview-calendar-week";
import { phxFieldClassName } from "@/components/ui/form-tokens";
import { adminControlDepthClassName, adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";

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
    <section aria-label="Your interviews" className={`border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
      <header className="flex items-center gap-2 border-b border-slate-200 border-l-[3px] border-l-orange-500 bg-slate-50 px-4 py-2.5">
        <CalendarClock className="h-4 w-4 shrink-0 text-orange-600" />
        <h2 className="text-sm font-black uppercase tracking-wide text-slate-900">Your interviews</h2>
        <span className="ml-auto text-xs font-semibold text-slate-500">{interviews.length} coming up</span>
      </header>

      <ul className="divide-y divide-slate-100">
        {interviews.map((interview) => (
          <li key={interview.id}>
            <Link
              className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-slate-50"
              href={`/employee-portals/interview-calendar?open=${encodeURIComponent(interview.id)}`}
            >
              <span className={`flex h-9 w-9 shrink-0 items-center justify-center border border-slate-200 bg-slate-50 text-slate-500 group-hover:border-orange-300 group-hover:text-orange-600 ${adminControlDepthClassName}`}>
                {interview.platform === "zoom" ? <Video className="h-4 w-4" /> : interview.platform === "phone" ? <Phone className="h-4 w-4" /> : <Building2 className="h-4 w-4" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block break-words text-sm font-bold text-slate-900">{interview.candidateName}</span>
                <span className="block text-xs text-slate-500">
                  {formatDayLong(interview.dateKey)} · {formatTimeRange(interview.startMinutes, interview.durationMinutes)} · {PLATFORM_LABEL[interview.platform]}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>

      <div className="border-t border-slate-200 px-4 py-3">
        {feedUrl ? (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-slate-600">
              Subscribe once and your interviews stay in your calendar, refreshing on their own. Add this link in Outlook, Google Calendar or your phone as a subscribed calendar (not an import).
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                aria-label="Your calendar subscription link"
                className={`${phxFieldClassName} min-w-0 flex-1`}
                readOnly
                value={feedUrl}
                onFocus={(event) => event.currentTarget.select()}
              />
              <button
                className={`inline-flex items-center gap-1.5 border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-bold text-slate-700 hover:border-orange-400 hover:text-orange-700 ${adminControlDepthClassName}`}
                onClick={() => void copy()}
                type="button"
              >
                {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? "Copied" : "Copy"}
              </button>
              {webcalUrl ? (
                <a
                  className="inline-flex items-center gap-1.5 border border-orange-600 bg-orange-600 px-2.5 py-1.5 text-xs font-bold text-white hover:bg-orange-700"
                  href={webcalUrl}
                >
                  <CalendarPlus className="h-3.5 w-3.5" />
                  Subscribe
                </a>
              ) : null}
            </div>
          </div>
        ) : (
          <button
            className="inline-flex items-center gap-1.5 text-xs font-bold text-orange-700 hover:text-orange-900 disabled:opacity-50"
            disabled={busy}
            onClick={() => void addToCalendar()}
            type="button"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CalendarPlus className="h-3.5 w-3.5" />}
            Add these to your own calendar
          </button>
        )}
        {error ? <p className="mt-1.5 text-xs font-semibold text-red-700">{error}</p> : null}
      </div>
    </section>
  );
}
