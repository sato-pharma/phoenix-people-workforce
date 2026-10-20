"use client";

/**
 * Phoenix CRM — the Visit report's map: where each visit was saved, the validated place beside it, and the
 * day's route.
 *
 * A filled square is a visit, numbered in the order its PERSON saved that day's visits; a hollow square is
 * the validated place it belongs to, tied to the visit by a dashed line when the phone was far from it.
 * Each person's route joins his visits of one day in save order with straight lines.
 *
 * 🔴 PER PERSON, NEVER ACROSS THE DISTRICT (2026-10-16). A district has several reps on one day; one
 * sequence over all of them numbered one rep's visits by another's saves and drew a single line from one
 * rep's door to another's, which is a route nobody travelled.
 *
 * 🔴 ONE MAP FOR THE ELEMENT'S LIFE (2026-10-16). Picking a visit or a day redraws the markers on the map
 * that is already there; building a new map each time reloaded every tile and threw away the reader's own
 * pan and zoom. The view is fitted again only when WHAT is shown changes, never for a highlight.
 *
 * 🔴 SAVE ORDER IS HOW THE REP LOGGED HIS DAY, NOT THE ORDER HE WAS AT THE DOORS (owner, 2026-10-02) — he
 * may log the morning from the car. The route is therefore drawn plain, with a sentence under the map that
 * says so, and nothing on it is ever coloured as a finding. Square markers throughout: the module's
 * square-edge rule applies to a map pin as much as a card.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { cairoClock, countText, dayLabel } from "@/components/phoenix-crm/format";
import { CrmBlock, CrmButton, CrmNote, CrmPanel } from "@/components/phoenix-crm/ui";
import {
  importGoogleLibrary,
  loadGoogleMaps,
  type GoogleMapHandle,
  type GoogleMapsApi,
  type GoogleMarkerHandle,
  type GooglePolylineHandle,
} from "@/lib/google-maps/browser";
import { formatDistance } from "@/lib/phoenix-crm/geo";
import type { VisitReportRow } from "@/lib/phoenix-crm/visit-report-fields";

const ALL_DAYS = "all";
const SQUARE = "M -9 -9 L 9 -9 L 9 9 L -9 9 z";
const VISIT_COLOUR = "#ea580c";
const FAR_COLOUR = "#be123c";
const PLACE_COLOUR = "#0A527D";

type Located = VisitReportRow & { visitLat: number; visitLon: number };

function isLocated(row: VisitReportRow): row is Located {
  return Number.isFinite(row.visitLat) && Number.isFinite(row.visitLon);
}

/** Whose day a visit is in: the person who visited, and the day. */
function personDayKey(row: VisitReportRow): string {
  return `${row.repName}|${row.visitDate}`;
}

function straightLineMetres(path: ReadonlyArray<Located>): number {
  let metres = 0;
  for (let index = 1; index < path.length; index += 1) {
    const a = path[index - 1];
    const b = path[index];
    const dLat = ((b.visitLat - a.visitLat) * Math.PI) / 180;
    const dLon = ((b.visitLon - a.visitLon) * Math.PI) / 180;
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((a.visitLat * Math.PI) / 180) * Math.cos((b.visitLat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
    metres += 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  return metres;
}

function squareIcon(fill: string, stroke: string, fillOpacity: number) {
  return { fillColor: fill, fillOpacity, path: SQUARE, scale: 1, strokeColor: stroke, strokeWeight: 2 };
}

export function VisitReportMap({
  highlightId,
  onPick,
  rows,
}: {
  highlightId: string | null;
  onPick: (visitId: string) => void;
  rows: ReadonlyArray<VisitReportRow>;
}) {
  const browserKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY ?? "";
  const mapRef = useRef<HTMLDivElement | null>(null);
  const markersRef = useRef<GoogleMarkerHandle[]>([]);
  const linesRef = useRef<GooglePolylineHandle[]>([]);
  const mapInstanceRef = useRef<{ element: HTMLDivElement; map: GoogleMapHandle } | null>(null);
  const fittedKeyRef = useRef<string | null>(null);
  const pickRef = useRef(onPick);
  const [googleMaps, setGoogleMaps] = useState<GoogleMapsApi | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    pickRef.current = onPick;
  }, [onPick]);

  const located = useMemo(() => rows.filter(isLocated), [rows]);
  const days = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of located) counts.set(row.visitDate, (counts.get(row.visitDate) ?? 0) + 1);
    return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right));
  }, [located]);

  const highlightDay = useMemo(() => located.find((row) => row.visitId === highlightId)?.visitDate ?? null, [highlightId, located]);
  const [pickedDay, setPickedDay] = useState<string | null>(null);
  const day = pickedDay && (pickedDay === ALL_DAYS || days.some(([key]) => key === pickedDay)) ? pickedDay : (highlightDay ?? days[0]?.[0] ?? ALL_DAYS);

  const shown = useMemo(() => {
    const inDay = day === ALL_DAYS ? located : located.filter((row) => row.visitDate === day);
    return inDay.slice().sort((left, right) => left.savedAtIso.localeCompare(right.savedAtIso));
  }, [day, located]);

  /** Each visit's number: its place in its own person's day, in save order. */
  const numberOf = useMemo(() => {
    const numbers = new Map<string, number>();
    const counts = new Map<string, number>();
    for (const row of shown) {
      const key = personDayKey(row);
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      numbers.set(row.visitId, next);
    }
    return numbers;
  }, [shown]);

  /** One route per person, only when ONE day is shown: seven days' lines would be a tangle that says nothing. */
  const routes = useMemo(() => {
    if (day === ALL_DAYS) return [];
    const byPerson = new Map<string, Located[]>();
    for (const row of shown) {
      const path = byPerson.get(row.repName) ?? [];
      path.push(row);
      byPerson.set(row.repName, path);
    }
    return [...byPerson.values()].filter((path) => path.length > 1);
  }, [day, shown]);

  /** What is shown — the view is fitted again only when this changes, never for a highlight alone. */
  const fitKey = useMemo(() => `${day}|${shown.map((row) => row.visitId).join(",")}`, [day, shown]);

  useEffect(() => {
    if (!browserKey || located.length === 0) return;
    let cancelled = false;
    void loadGoogleMaps(browserKey)
      .then((maps) => {
        if (!cancelled) setGoogleMaps(maps);
      })
      .catch(() => {
        if (!cancelled) setError("Google Maps could not load. The visits table below still holds every position.");
      });
    return () => {
      cancelled = true;
    };
  }, [browserKey, located.length]);

  useEffect(() => {
    const element = mapRef.current;
    if (!googleMaps || !element || shown.length === 0) return;
    let cancelled = false;

    const draw = async () => {
      try {
        const core = await importGoogleLibrary(googleMaps, "core", { LatLngBounds: googleMaps.LatLngBounds });
        const maps = await importGoogleLibrary(googleMaps, "maps", { Map: googleMaps.Map, Polyline: googleMaps.Polyline });
        const marker = await importGoogleLibrary(googleMaps, "marker", { Marker: googleMaps.Marker });
        if (cancelled) return;
        const MapCtor = (maps?.Map as GoogleMapsApi["Map"]) ?? googleMaps.Map;
        const MarkerCtor = (marker?.Marker as GoogleMapsApi["Marker"]) ?? googleMaps.Marker;
        const PolylineCtor = (maps?.Polyline as GoogleMapsApi["Polyline"]) ?? googleMaps.Polyline;
        const BoundsCtor = (core?.LatLngBounds as GoogleMapsApi["LatLngBounds"]) ?? googleMaps.LatLngBounds;
        if (!MapCtor || !MarkerCtor) {
          setError("Google Maps loaded, but the map renderer is unavailable. Refresh and try again.");
          return;
        }

        markersRef.current.forEach((handle) => handle.setMap?.(null));
        markersRef.current = [];
        linesRef.current.forEach((handle) => handle.setMap(null));
        linesRef.current = [];

        const first = shown[0];
        const existing = mapInstanceRef.current;
        let map: GoogleMapHandle;
        if (existing && existing.element === element) {
          map = existing.map;
        } else {
          map = new MapCtor(element, {
            center: { lat: first.visitLat, lng: first.visitLon },
            mapTypeControl: false,
            streetViewControl: false,
            zoom: 13,
          });
          mapInstanceRef.current = { element, map };
          fittedKeyRef.current = null;
        }
        const bounds = BoundsCtor ? new BoundsCtor() : null;

        shown.forEach((row, index) => {
          const number = numberOf.get(row.visitId) ?? index + 1;
          const spot = { lat: row.visitLat, lng: row.visitLon };
          bounds?.extend(spot);
          const far = row.locationFlag === "Far from the place";
          const picked = row.visitId === highlightId;

          const visitMarker = new MarkerCtor({
            icon: squareIcon(far ? FAR_COLOUR : VISIT_COLOUR, picked ? "#0f172a" : "#ffffff", 1),
            label: { color: "#ffffff", fontSize: "11px", fontWeight: "800", text: String(number) },
            map,
            position: spot,
            title: `${number}. ${row.repName} · ${row.customerName} — ${cairoClock(row.savedAtIso)}`,
            zIndex: picked ? 1000 : 10 + index,
          });
          visitMarker.addListener?.("click", () => pickRef.current(row.visitId));
          markersRef.current.push(visitMarker);

          if (row.placeLat !== null && row.placeLon !== null && Number.isFinite(row.placeLat) && Number.isFinite(row.placeLon)) {
            const place = { lat: row.placeLat, lng: row.placeLon };
            bounds?.extend(place);
            const placeMarker = new MarkerCtor({
              icon: squareIcon("#ffffff", PLACE_COLOUR, 0.9),
              map,
              position: place,
              title: `${row.placeLabel ?? row.customerName} — the validated place`,
              zIndex: 5,
            });
            placeMarker.addListener?.("click", () => pickRef.current(row.visitId));
            markersRef.current.push(placeMarker);

            if (far && PolylineCtor) {
              linesRef.current.push(
                new PolylineCtor({
                  icons: [{ icon: { path: "M 0,-1 0,1", scale: 3, strokeColor: FAR_COLOUR, strokeOpacity: 1 }, offset: "0", repeat: "10px" }],
                  map,
                  path: [spot, place],
                  strokeOpacity: 0,
                }),
              );
            }
          }
        });

        if (PolylineCtor) {
          for (const path of routes) {
            linesRef.current.push(
              new PolylineCtor({
                map,
                path: path.map((row) => ({ lat: row.visitLat, lng: row.visitLon })),
                strokeColor: VISIT_COLOUR,
                strokeOpacity: 0.85,
                strokeWeight: 3,
              }),
            );
          }
        }

        if (fittedKeyRef.current !== fitKey) {
          fittedKeyRef.current = fitKey;
          if (bounds && shown.length > 1) {
            map.fitBounds(bounds, 64);
          } else {
            map.setCenter?.({ lat: first.visitLat, lng: first.visitLon });
            map.setZoom?.(13);
          }
        }
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Google Maps could not draw the visits.");
      }
    };

    void draw();
    return () => {
      cancelled = true;
    };
  }, [fitKey, googleMaps, highlightId, numberOf, routes, shown]);

  // A manager's own single visit carries no position BY RULE — none is asked of it (owner, 2026-10-20) — so it is
  // never counted among the visits that "have no position", which reads as a reading that failed.
  const ownVisits = rows.filter((row) => row.ownVisit === true).length;
  const missing = rows.length - ownVisits - located.length;
  const routeKm = useMemo(
    () => (routes.length === 0 ? null : routes.reduce((sum, path) => sum + straightLineMetres(path), 0)),
    [routes],
  );

  if (!browserKey) {
    return (
      <CrmPanel eyebrow="Map" title="The map is unavailable">
        <CrmBlock>
          <CrmNote tone="warn">The Google Maps browser key is missing from this environment. The visits table below still holds every position.</CrmNote>
        </CrmBlock>
      </CrmPanel>
    );
  }

  return (
    <CrmPanel
      description="A filled square is a visit, numbered in the order its person saved that day's visits. A hollow square is the validated place, tied to the visit by a dashed line when the phone was far from it."
      eyebrow="Map"
      title="Where the visits were saved"
    >
      {located.length === 0 ? (
        <CrmBlock>
          <CrmNote>No visit in this period carries a position, so there is nothing to draw.</CrmNote>
        </CrmBlock>
      ) : (
        <CrmBlock>
          <div className="mb-3 flex flex-wrap gap-2">
            {days.map(([key, count]) => (
              <CrmButton aria-pressed={day === key} key={key} onClick={() => setPickedDay(key)} size="sm" variant={day === key ? "primary" : "secondary"}>
                {dayLabel(key)} · {countText(count)}
              </CrmButton>
            ))}
            {days.length > 1 ? (
              <CrmButton aria-pressed={day === ALL_DAYS} onClick={() => setPickedDay(ALL_DAYS)} size="sm" variant={day === ALL_DAYS ? "primary" : "secondary"}>
                All days · {countText(located.length)}
              </CrmButton>
            ) : null}
          </div>
          <ul className="mb-2 flex flex-wrap gap-x-5 gap-y-1.5 text-xs font-semibold text-slate-600">
            <li className="flex items-center gap-1.5">
              <span aria-hidden className="inline-block h-3 w-3 border border-white bg-orange-600 shadow-[0_0_0_1px_#ea580c]" />
              {"Visit, numbered in its person's save order"}
            </li>
            <li className="flex items-center gap-1.5">
              <span aria-hidden className="inline-block h-3 w-3 border-2 border-[#0A527D] bg-white" />
              Validated place
            </li>
            <li className="flex items-center gap-1.5">
              <span aria-hidden className="inline-block h-3 w-3 border border-white bg-rose-700 shadow-[0_0_0_1px_#be123c]" />
              Visit far from its place
            </li>
            <li className="flex items-center gap-1.5">
              <span aria-hidden className="inline-block h-0 w-5 border-t-2 border-dashed border-rose-700" />
              Tie from visit to place
            </li>
          </ul>
          <div className="h-[360px] min-w-0 border border-slate-200 bg-slate-50 sm:h-[460px]" ref={mapRef} />
          {error ? <p className="mt-2 text-sm font-semibold text-amber-800">{error}</p> : null}
          {!googleMaps && !error ? <p className="mt-2 text-sm font-medium text-slate-500">Loading Google Maps</p> : null}
          <p className="mt-2 break-words text-xs font-medium leading-5 text-slate-500">
            {routeKm === null
              ? ""
              : routes.length === 1
                ? `The line joins this day's visits in the order they were saved: ${formatDistance(routeKm)} in a straight line between them. `
                : `Each line joins one person's visits that day in the order they were saved: ${formatDistance(routeKm)} in a straight line, all lines together. `}
            Save order is how the day was logged, not the order the doors were reached.
            {missing > 0 ? ` ${countText(missing)} visit${missing === 1 ? " has" : "s have"} no position and ${missing === 1 ? "is" : "are"} not drawn.` : ""}
            {ownVisits > 0
              ? ` ${countText(ownVisits)} ${ownVisits === 1 ? "visit is the manager's own and is" : "visits are the manager's own and are"} listed in the table, not on the map: no position is asked of a manager's own visit.`
              : ""}
          </p>
        </CrmBlock>
      )}
    </CrmPanel>
  );
}
