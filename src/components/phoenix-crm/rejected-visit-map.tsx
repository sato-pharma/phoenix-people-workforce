/**
 * Phoenix CRM — the rep's own rejected visit, on a small read-only map (owner, 28 Nov 2026: "reject the visit
 * and show the rep that the visit is rejected … show him what I am seeing in here, the map. He submitted the
 * visit here, and the doctor is here, so it is rejected … But of course, read only").
 *
 * The same picture the SFE decides on: 1 where the visit was submitted, 2 the customer's saved place, 3 where
 * the place's photo was captured, a dashed line from 1 to 2 and the distances in words. Nothing to press but
 * each point's Google Maps link. Drawn only for a visit the SFE REFUSED (`farVisitRejection`, built on the
 * server by `loadFarVisitRejections`); a visit still waiting or approved shows nothing new.
 */
import type { VisitRow } from "@/lib/phoenix-crm/view-types";

type Rejection = NonNullable<VisitRow["farVisitRejection"]>;

function mapsLink(point: { lat: number; lon: number }): string {
  return `https://www.google.com/maps/search/?api=1&query=${point.lat.toFixed(6)},${point.lon.toFixed(6)}`;
}

export function RejectedVisitMap({ rejection }: { rejection: Rejection }) {
  const { map, points } = rejection;
  const submitted = map?.markers[0];
  const place = map?.markers[1];
  return (
    <div className="mt-2 border border-rose-200 bg-rose-50/60 p-3">
      <p className="break-words text-sm font-bold text-rose-800">{rejection.label}</p>
      <p className="mt-0.5 break-words text-xs leading-5 text-slate-700">{rejection.note}</p>
      {map ? (
        <div className="mt-2 flex flex-wrap items-start gap-3">
          <div className="relative max-w-full shrink-0 overflow-hidden border border-slate-200 bg-slate-100" style={{ height: map.height, width: map.width }}>
            {/* The streets, one picture from the app's own route. Its size is pinned in pixels: the markers sit on
                the frame's own pixels, so a picture that shrank would put them on the wrong streets. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img alt="" aria-hidden className="absolute left-0 top-0 max-w-none select-none" height={map.height} loading="lazy" src={map.basemapUrl} style={{ height: map.height, maxWidth: "none", width: map.width }} width={map.width} />
            <svg aria-hidden className="pointer-events-none absolute inset-0" height={map.height} width={map.width}>
              {submitted && place ? <line stroke="#e11d48" strokeDasharray="4 3" strokeWidth={2} x1={submitted.left} x2={place.left} y1={submitted.top} y2={place.top} /> : null}
            </svg>
            {map.markers.map((marker) => (
              // Square, like everything else on this platform (the square-edge golden rule).
              <span
                className={`absolute -ml-3 -mt-3 flex h-6 w-6 items-center justify-center border-2 border-white text-xs font-black text-white ${marker.index === 1 ? "bg-rose-600" : "bg-slate-800"}`}
                key={`${marker.index}-${marker.lat}-${marker.lon}`}
                style={{ left: marker.left, top: marker.top }}
              >
                {marker.index}
              </span>
            ))}
          </div>
          <div className="min-w-0 flex-1 basis-48 space-y-1.5">
            {points.map((point) => (
              <p className="break-words text-xs leading-5 text-slate-700" key={point.index}>
                <span className="font-bold text-slate-900">
                  {point.index}. {point.label}
                </span>{" "}
                ·{" "}
                <a className="font-semibold text-sky-700 underline" href={mapsLink(point)} rel="noreferrer" target="_blank">
                  Open in Google Maps
                </a>
              </p>
            ))}
            {map.pairs.map((pair) => (
              <p className="break-words text-xs font-semibold leading-5 text-slate-800" key={`pair-${pair.fromIndex}-${pair.toIndex}`}>
                {pair.text}
              </p>
            ))}
            <p className="break-words text-xs uppercase tracking-wide text-slate-400">{map.attribution}</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
