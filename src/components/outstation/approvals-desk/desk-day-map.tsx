"use client";

import { useEffect, useRef, useState } from "react";

import { FieldWorkforceRouteMap, type TripRouteLine } from "@/components/field-workforce-compliance/field-workforce-route-map";
import { formatDateTimeValue, formatNumberValue } from "@/lib/i18n/format";
import type { DeskDayMap } from "@/lib/outstation/approvals/day-map";

const MAP_COPY = { description: "", empty: "Nothing with a position this day", title: "The day on a map" };

const mapsHref = (lat: number, lon: number) => `https://www.google.com/maps?q=${lat},${lon}`;

/**
 * True once the element has come near the screen — and stays true. The reviewer scrolls in its own
 * box, not the window, so the fallback listens to scrolls in the capture phase (an inner box's
 * scroll never reaches the window). Nothing is behind a click: the map draws as he reaches it.
 */
function useSeenOnce<T extends HTMLElement>(margin = 320) {
  const ref = useRef<T | null>(null);
  // No observer (an old browser, a test renderer): draw at once rather than never.
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const element = ref.current;
    if (!element || seen) return;
    const check = () => {
      const box = element.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) return;
      if (box.top < window.innerHeight + margin) setSeen(true);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
      },
      { rootMargin: `${margin}px` },
    );
    observer.observe(element);
    const frame = window.requestAnimationFrame(check);
    document.addEventListener("scroll", check, { capture: true, passive: true });
    window.addEventListener("resize", check);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
      document.removeEventListener("scroll", check, { capture: true });
      window.removeEventListener("resize", check);
    };
  }, [margin, seen]);
  return { ref, seen };
}

/**
 * One trip day on its own map, with a legend that names every pin so the map reads without hovering.
 *
 * What is drawn, and the move of a visit's saved time onto Cairo's wall clock, are decided in
 * `@/lib/outstation/approvals/day-map` — this only draws it. A six-day trip is six maps; each is
 * created when its day comes into view, so opening a trip costs one map, not six.
 */
export function DeskDayMapBox({ map, routeLine }: { map: DeskDayMap; routeLine: TripRouteLine | null }) {
  const { ref, seen } = useSeenOnce<HTMLDivElement>();
  // `map` is built once per trip read (desk-days.tsx memoizes it), so the pins keep their identity
  // between renders — the map re-creates itself when they change it.
  const { checkins, markers } = map;
  const tripRoute = map.tripRoute ? routeLine : null;

  if (!map.hasPoints && map.legend.length === 0 && map.unplaced === 0) return null;

  return (
    <div className="min-w-0 border-t border-slate-100 px-3 py-2.5" data-day-map={map.date} ref={ref}>
      {map.hasPoints ? (
        <div className="min-w-0">
          {seen ? (
            <FieldWorkforceRouteMap checkins={checkins} copy={MAP_COPY} frame="bare" markers={markers} route={null} tripRoute={tripRoute} />
          ) : (
            <div aria-hidden className="h-64 w-full border border-slate-200 bg-slate-50" />
          )}
        </div>
      ) : null}
      <ul className="mt-2 grid min-w-0 gap-1 text-xs text-slate-600" data-day-map-legend>
        {map.checkins.length > 0 ? (
          <li className="break-words">
            <span className="font-black text-slate-900">1{map.checkins.length > 1 ? `–${formatNumberValue(map.checkins.length)}` : ""}</span>
            {" · "}
            {map.checkins.length === 1 ? "The day's visit" : "The day's visits, numbered in the order they were saved"}
          </li>
        ) : null}
        {map.legend.map((line) => (
          <li className="break-words" key={`${line.label}-${line.name}`}>
            <span className="font-black text-slate-900">{line.label}</span>
            {" · "}
            {line.name}
            {line.at ? ` · ${formatDateTimeValue(line.at)}` : ""}
            {line.note ? <span className="text-amber-700"> · {line.note}</span> : null}
            {line.point ? (
              <>
                {" · "}
                <a
                  className="tabular-nums text-slate-500 underline decoration-slate-300 underline-offset-2 hover:text-orange-700"
                  href={mapsHref(line.point.lat, line.point.lon)}
                  rel="noreferrer"
                  target="_blank"
                  title="Open this point on Google Maps"
                >
                  {line.point.lat.toFixed(5)}, {line.point.lon.toFixed(5)}
                </a>
              </>
            ) : null}
          </li>
        ))}
        {map.tripRoute && routeLine ? <li className="break-words">The orange line is the road route the claim was priced on, from home.</li> : null}
        {map.unplaced > 0 ? (
          <li className="break-words text-amber-700">
            {formatNumberValue(map.unplaced)} {map.unplaced === 1 ? "visit was" : "visits were"} saved with no position and {map.unplaced === 1 ? "is" : "are"} not on the map.
          </li>
        ) : null}
      </ul>
    </div>
  );
}
