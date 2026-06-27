"use client";

import { CalendarDays, Clock } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * Live date + time for the CEO hero, rendered in Cairo local time and ticking each
 * second. Two bordered segments designed to sit inside the hero's pill bar. Renders a
 * stable placeholder on the server to avoid hydration mismatch, then hydrates to live.
 */
export function CeoHeroClock() {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    const tick = () => setNow(new Date());
    const first = window.setTimeout(tick, 0);
    const id = window.setInterval(tick, 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, []);

  const dateStr = now
    ? new Intl.DateTimeFormat("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "Africa/Cairo",
      }).format(now)
    : "—";
  const timeStr = now
    ? new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZone: "Africa/Cairo",
      }).format(now)
    : "—";

  return (
    <>
      <span className="flex items-center gap-2 px-3.5 py-2.5 text-slate-200">
        <CalendarDays aria-hidden="true" className="h-3.5 w-3.5 text-slate-400" />
        <span className="font-semibold tracking-wide">{dateStr}</span>
      </span>
      <span className="flex items-center gap-2 border-l border-white/12 px-3.5 py-2.5 text-slate-200">
        <Clock aria-hidden="true" className="h-3.5 w-3.5 text-slate-400" />
        <span className="font-semibold tracking-wide tabular-nums">{timeStr}</span>
      </span>
    </>
  );
}
