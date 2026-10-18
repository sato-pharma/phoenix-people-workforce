"use client";

// Opens an interview's Zoom link by itself when its time arrives — the owner, 2026-09-19: "when it
// comes its time, it auto opens; it doesn't wait for me to open it".
//
// HOW. The page asks the server every 15 seconds which Zoom interviews are starting for THIS person
// (the interviewer, or the calendar's owner when none is chosen — see listDueZoomInterviews) and opens
// the link in a new tab. The server decides whose interview it is, so someone the calendar is only
// shared with is never sent to a meeting that is not theirs.
//
// WHAT A BROWSER WON'T DO. A tab opened by a timer rather than a press is a pop-up, and a browser
// blocks it until the site is allowed to open pop-ups. So when it is blocked the screen says so and
// offers one press that opens the meeting; it never fails silently. The page must also be open: this
// cannot run from a closed tab.
//
// OFF SWITCH. It is on by default and remembered per browser. Each interview opens once, remembered
// across reloads so refreshing the page mid-interview does not open it again.

import { Video } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Action } from "@/components/recruitment/workstation/workstation-look";
import { formatTimeOfDay } from "@/lib/recruitment/interview-calendar-week";
import type { DueZoomInterview } from "@/lib/recruitment/interview-calendar-types";
import { cn } from "@/lib/utils";

import type { CalendarApi } from "./calendar-api";

const POLL_MS = 15_000;
const SWITCH_KEY = "phoenix.interviewCalendar.zoomAutoOpen";
const OPENED_KEY = "phoenix.interviewCalendar.zoomOpened";
const OPENED_KEEP = 40;

function readSwitch(): boolean {
  try {
    return window.localStorage.getItem(SWITCH_KEY) !== "off";
  } catch {
    return true;
  }
}

function readOpened(): string[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(OPENED_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function rememberOpened(key: string) {
  try {
    const next = [...readOpened().filter((entry) => entry !== key), key].slice(-OPENED_KEEP);
    window.localStorage.setItem(OPENED_KEY, JSON.stringify(next));
  } catch {
    // Without storage it may open again after a reload — a minor repeat, never a missed interview.
  }
}

const keyOf = (due: DueZoomInterview) => `${due.bookingId}:${due.dateKey}:${due.startMinutes}`;

export function ZoomAutoOpen({ api }: { api: CalendarApi }) {
  const [on, setOn] = useState(true);
  const [blocked, setBlocked] = useState<DueZoomInterview[]>([]);
  const busy = useRef(false);

  // Read after hydration (the server cannot see this browser's storage), in a timer so the first
  // paint and the server's markup agree.
  useEffect(() => {
    const timer = window.setTimeout(() => setOn(readSwitch()), 0);
    return () => window.clearTimeout(timer);
  }, []);

  const check = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const data = await api.get("/zoom-due");
      const due = Array.isArray(data.due) ? (data.due as DueZoomInterview[]) : [];
      const opened = new Set(readOpened());
      for (const meeting of due) {
        const key = keyOf(meeting);
        if (opened.has(key)) continue;
        // No `noopener` feature: with it a window.open answers null even when the tab opened, which would
        // read as a block. The opener is cut by hand instead.
        const tab = window.open(meeting.openUrl, "_blank");
        if (tab) {
          tab.opener = null;
          rememberOpened(key);
        } else {
          setBlocked((current) => (current.some((entry) => keyOf(entry) === key) ? current : [...current, meeting]));
        }
      }
    } catch {
      // A missed check is retried in 15 seconds; nothing to tell the person.
    } finally {
      busy.current = false;
    }
  }, [api]);

  useEffect(() => {
    if (!on) return;
    const first = window.setTimeout(() => void check(), 0);
    const timer = window.setInterval(() => void check(), POLL_MS);
    const wake = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", wake);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [check, on]);

  function toggle() {
    const next = !on;
    setOn(next);
    if (!next) setBlocked([]);
    try {
      window.localStorage.setItem(SWITCH_KEY, next ? "on" : "off");
    } catch {
      // Not remembered; the switch still works for this visit.
    }
  }

  function joinNow(meeting: DueZoomInterview) {
    const tab = window.open(meeting.openUrl, "_blank");
    if (tab) tab.opener = null;
    rememberOpened(keyOf(meeting));
    setBlocked((current) => current.filter((entry) => keyOf(entry) !== keyOf(meeting)));
  }

  return (
    <div className="flex flex-col gap-2">
      {blocked.map((meeting) => (
        <div className="flex flex-wrap items-center justify-between gap-2 border border-orange-200 border-l-[3px] border-l-orange-600 bg-orange-50 px-3 py-2" key={keyOf(meeting)} role="alert">
          <p className="min-w-0 break-words text-[13px] text-slate-900">
            <span className="font-bold">{meeting.candidateName}</span>&apos;s Zoom interview is starting ({formatTimeOfDay(meeting.startMinutes)}). Your browser stopped it opening by itself — allow
            pop-ups for Phoenix to have it open on its own.
          </p>
          <Action onClick={() => joinNow(meeting)} tone="primary">
            <Video className="h-3.5 w-3.5" />
            Join Zoom now
          </Action>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-slate-600">
        <button
          aria-pressed={on}
          className={cn("inline-flex items-center gap-1.5 border px-2 py-1 font-bold", on ? "border-emerald-600 bg-emerald-50 text-emerald-800" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50")}
          onClick={toggle}
          type="button"
        >
          <Video className="h-3.5 w-3.5" />
          Open Zoom by itself: {on ? "On" : "Off"}
        </button>
        <span className="min-w-0 break-words">
          {on ? "Your Zoom interviews open here when their time comes — keep this page open." : "Turned off — you open each Zoom yourself."}
        </span>
      </div>
    </div>
  );
}
