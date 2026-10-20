"use client";

// Recruitment workspace — "N new CVs" (owner, 20 Oct 2026: new CVs appear live behind a bar).
//
// It asks the arrivals route once a minute, and only while this tab is the one on screen: a hidden
// tab polling all afternoon is load nobody reads. New CVs are NOT pushed into the list on their own —
// a row jumping in under the reader's cursor is how the wrong person gets rejected — the bar says how
// many arrived and the reader brings them in when ready.

import { BellRing } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { getJson } from "@/components/recruitment/recruitment-fetch";

const POLL_MS = 60_000;

export function NewCvsBar({ onShow, query, since }: { onShow: () => void; query: string; since: string | null }) {
  const [count, setCount] = useState(0);
  const latestQuery = useRef(query);
  const latestSince = useRef(since);
  useEffect(() => {
    latestQuery.current = query;
    latestSince.current = since;
  }, [query, since]);

  useEffect(() => {
    let stopped = false;
    const ask = async () => {
      if (document.visibilityState !== "visible" || !latestSince.current) return;
      try {
        const separator = latestQuery.current ? "&" : "";
        const data = await getJson(
          `/api/recruitment/workspace/arrivals?since=${encodeURIComponent(latestSince.current)}${separator}${latestQuery.current}`,
        );
        if (!stopped) setCount(typeof data.count === "number" ? data.count : 0);
      } catch {
        // A failed poll says nothing; the next minute asks again.
      }
    };
    const timer = setInterval(() => void ask(), POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void ask();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (count <= 0) return null;
  return (
    <button
      className="flex w-full items-center justify-center gap-2 border-b border-sky-200 bg-sky-50 px-4 py-2 text-sm font-black text-sky-900 transition hover:bg-sky-100"
      onClick={() => {
        setCount(0);
        onShow();
      }}
      type="button"
    >
      <BellRing aria-hidden className="h-4 w-4" />
      <span className="tabular-nums">{count === 1 ? "1 new CV" : `${count} new CVs`}</span>
      <span className="font-semibold text-sky-700">— show them</span>
    </button>
  );
}
