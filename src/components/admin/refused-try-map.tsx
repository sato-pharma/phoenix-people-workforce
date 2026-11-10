/**
 * Phoenix CRM — where the phone was when a try was refused, beside the customer's saved place, on one
 * small map (owner, 2026-11-10: "make any location of a logged visit even if failed to be saved and
 * shown only in admin account vs the correct location"; asked and answered: the Super Admin and the
 * SFE Manager, a small map on each row of the refused readings board).
 *
 * Marker 1 is the phone, marker 2 the saved place, a dashed line between them and the distance in
 * words; each point opens in Google Maps. A server component with no state: it draws what the board
 * built (`buildCaseMap`) and asks nothing. The tiles are `lazy` because the board lists up to a hundred
 * tries and the hidden copy (desktop or phone) of an eager image still loads.
 *
 * 🔴 It lives under `components/admin`, never `components/phoenix-crm`: that folder is the rep-facing
 * surface the blind half sweeps, and this map is drawn only on the Super Admin's and the SFE Manager's board.
 */

import type { CaseMap } from "@/lib/crm-integrity/integrity-case-map";
import { mapsLinkOf } from "@/lib/phoenix-crm/refused-readings-rules";

type Point = { lat: number; lon: number };

function PointLine({ index, label, point, detail }: { index: number; label: string; point: Point; detail: string }) {
  return (
    <p className="break-words text-xs leading-5 text-slate-700">
      <span className="font-bold text-slate-900">
        {index}. {label}
      </span>{" "}
      —{" "}
      <span className="tabular-nums">
        {point.lat.toFixed(6)}, {point.lon.toFixed(6)}
      </span>
      {detail} ·{" "}
      <a className="font-semibold text-sky-700 underline" href={mapsLinkOf(point)} rel="noreferrer" target="_blank">
        Open in Google Maps
      </a>
    </p>
  );
}

export function TryLocationsMap({
  map,
  tryPoint,
  savedPlace,
}: {
  map: CaseMap | null;
  tryPoint: (Point & { accuracyMeters: number | null }) | null;
  savedPlace: (Point & { address: string | null }) | null;
}) {
  if (!map || !tryPoint) {
    return <p className="text-xs leading-5 text-slate-500">The phone sent no position with this try, so there is nothing to place on a map.</p>;
  }
  const phone = map.markers[0];
  const place = savedPlace ? map.markers[1] : undefined;
  return (
    <div className="flex flex-wrap items-start gap-4">
      <div className="relative max-w-full shrink-0 overflow-hidden border border-slate-200 bg-slate-100" style={{ height: map.height, width: map.width }}>
        {map.tiles.map((tile) => (
          // A map tile is one fixed-size PNG from a third-party host, positioned by hand; the image
          // optimiser would proxy every tile through this app for nothing. The directive stays the LAST line.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            alt=""
            aria-hidden
            className="absolute select-none"
            key={tile.key}
            loading="lazy"
            src={tile.url}
            style={{ height: tile.size, left: tile.left, top: tile.top, width: tile.size }}
          />
        ))}
        <svg aria-hidden className="pointer-events-none absolute inset-0" height={map.height} width={map.width}>
          {phone && place ? (
            <line stroke="#e11d48" strokeDasharray="4 3" strokeWidth={2} x1={phone.left} x2={place.left} y1={phone.top} y2={place.top} />
          ) : null}
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
      <div className="min-w-0 flex-1 space-y-2">
        <PointLine
          detail={tryPoint.accuracyMeters !== null ? ` (within ${Math.round(tryPoint.accuracyMeters)} m)` : ""}
          index={1}
          label={phone?.label ?? "Where the phone was"}
          point={tryPoint}
        />
        {savedPlace ? (
          <PointLine
            detail={savedPlace.address ? ` · ${savedPlace.address}` : ""}
            index={2}
            label={place?.label ?? "Customer's saved place"}
            point={savedPlace}
          />
        ) : (
          <p className="text-xs leading-5 text-slate-500">This customer has no saved place yet, so there is only the phone to show.</p>
        )}
        {map.pairs.map((pair) => (
          <p className="break-words text-xs font-semibold leading-5 text-slate-800" key={`pair-${pair.fromIndex}-${pair.toIndex}`}>
            {pair.text}
          </p>
        ))}
        <p className="text-xs uppercase tracking-wide text-slate-400">{map.attribution}</p>
      </div>
    </div>
  );
}
