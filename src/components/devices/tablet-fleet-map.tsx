"use client";

/**
 * The tablets on a map — the whole fleet's last-known positions, or one tablet's movement trail.
 *
 * It reuses the same Google Maps browser loader as the field-visit and outstation maps
 * (`@/lib/google-maps/browser`); Phoenix never draws tiles itself. The data is the fleet the page
 * already read, reshaped by `@/lib/devices/headwind/dashboard` — this component only renders it.
 *
 * DESIGN IDENTITY is the devices sections around it: a slate border, square corners (the admin shell
 * zeroes every radius), nothing truncated. It is NOT the field map's rounded Card — a one-off look on
 * this page would read as pasted in.
 *
 * 🔴 IT FAILS TO A SENTENCE, NEVER A BROKEN FRAME. No browser key, no positions, or a Maps load error
 * each render as a plain line where the map would be, so a tablet nobody can place never reads as a
 * tablet at (0, 0).
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { type MapPoint } from "@/lib/devices/headwind/dashboard";
import { cairoDateTime } from "@/lib/format/cairo-datetime";
import {
  importGoogleLibrary,
  loadGoogleMaps,
  type GoogleMapsApi,
  type GoogleMarkerHandle,
  type GooglePolylineHandle,
} from "@/lib/google-maps/browser";

const FRAME = "border border-slate-200 bg-white px-4 py-3";
const MICRO_LABEL = "text-[9px] font-black uppercase tracking-[0.14em] text-slate-500";

/**
 * A trail stop's tooltip carries its Cairo time; a fleet marker's carries the holder AND when the
 * position was taken. 🔴 A fleet pin with no time used to read as "this tablet is here now".
 */
function markerTitle(point: MapPoint, kind: "fleet" | "trail"): string {
  if (kind === "trail") {
    const head = `${point.order ?? point.label}. ${point.label}`;
    return point.sublabel ? `${head} — ${cairoDateTime(point.sublabel)}` : head;
  }
  const when = point.recordedAt ? `position taken ${cairoDateTime(point.recordedAt)}` : "time of fix not reported";
  const parts = [point.label, point.sublabel, point.stale ? `OLD POSITION — ${when}` : when];
  return parts.filter((part): part is string => Boolean(part)).join(" — ");
}

export function TabletFleetMap({
  points,
  kind,
  title,
  caption,
}: {
  points: MapPoint[];
  kind: "fleet" | "trail";
  title: string;
  caption: string;
}) {
  const browserKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY ?? "";
  const mapRef = useRef<HTMLDivElement | null>(null);
  const markersRef = useRef<GoogleMarkerHandle[]>([]);
  const polylinesRef = useRef<GooglePolylineHandle[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [googleMaps, setGoogleMaps] = useState<GoogleMapsApi | null>(null);

  // A stable identity for the draw effect — the set of coordinates, in order.
  const signature = useMemo(
    () => points.map((point) => `${point.latitude},${point.longitude}`).join("|"),
    [points],
  );

  useEffect(() => {
    if (!browserKey || points.length === 0) return;
    let cancelled = false;
    void loadGoogleMaps(browserKey)
      .then((maps) => {
        if (cancelled) return;
        setGoogleMaps(maps);
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) setError("Google Maps failed to load. Check the browser key restrictions.");
      });
    return () => {
      cancelled = true;
    };
  }, [browserKey, points.length]);

  useEffect(() => {
    const mapElement = mapRef.current;
    if (!ready || !mapElement || !googleMaps || points.length === 0) return;
    let cancelled = false;

    const run = async () => {
      try {
        const coreLibrary = await importGoogleLibrary(googleMaps, "core", { LatLngBounds: googleMaps.LatLngBounds });
        const mapsLibrary = await importGoogleLibrary(googleMaps, "maps", { Map: googleMaps.Map, Polyline: googleMaps.Polyline });
        const markerLibrary = await importGoogleLibrary(googleMaps, "marker", { Marker: googleMaps.Marker });
        if (cancelled) return;

        const MapCtor = (mapsLibrary?.Map as GoogleMapsApi["Map"]) ?? googleMaps.Map;
        const MarkerCtor = (markerLibrary?.Marker as GoogleMapsApi["Marker"]) ?? googleMaps.Marker;
        const PolylineCtor = (mapsLibrary?.Polyline as GoogleMapsApi["Polyline"]) ?? googleMaps.Polyline;
        const LatLngBoundsCtor = (coreLibrary?.LatLngBounds as GoogleMapsApi["LatLngBounds"]) ?? googleMaps.LatLngBounds;
        if (!MapCtor) {
          setError("Google Maps loaded, but the map renderer is unavailable. Refresh and retry.");
          return;
        }

        markersRef.current.forEach((marker) => {
          if (typeof marker.setMap === "function") marker.setMap(null);
          else if ("map" in marker) marker.map = null;
        });
        markersRef.current = [];
        polylinesRef.current.forEach((polyline) => polyline.setMap?.(null));
        polylinesRef.current = [];

        const path = points.map((point) => ({ lat: point.latitude, lng: point.longitude }));
        const map = new MapCtor(mapElement, {
          center: path[0],
          mapTypeControl: false,
          streetViewControl: false,
          zoom: 12,
        });

        if (MarkerCtor) {
          points.forEach((point) => {
            markersRef.current.push(
              new MarkerCtor({
                // A trail numbers its stops on the pin; the fleet leans on the tooltip so the pins stay legible.
                ...(kind === "trail" ? { label: String(point.order ?? point.label) } : {}),
                // An old or undated fleet position is drawn faded, so it is never read as where the tablet is now.
                ...(kind === "fleet" && point.stale ? { opacity: 0.45 } : {}),
                map,
                position: { lat: point.latitude, lng: point.longitude },
                title: markerTitle(point, kind),
              }),
            );
          });
        }

        // A trail joins its stops in time order; the fleet is scattered tablets and draws no line.
        if (kind === "trail" && PolylineCtor && path.length > 1) {
          polylinesRef.current.push(
            new PolylineCtor({ map, path, strokeColor: "#f97316", strokeOpacity: 0.9, strokeWeight: 4 }),
          );
        }

        const bounds = LatLngBoundsCtor ? new LatLngBoundsCtor() : null;
        path.forEach((point) => bounds?.extend(point));
        if (bounds && path.length > 1) map.fitBounds(bounds, 48);
        else if (path.length === 1) {
          map.setCenter?.(path[0]);
          map.setZoom?.(15);
        }
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Google Maps could not draw the tablets.");
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [googleMaps, kind, points, ready, signature]);

  if (!browserKey) {
    return (
      <div className={FRAME}>
        <p className={MICRO_LABEL}>{title}</p>
        <p className="mt-2 break-words text-[11px] font-semibold text-slate-500">
          The map needs a Google Maps browser key (NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY) that is not set here.
          Every tablet&rsquo;s position is still listed below.
        </p>
      </div>
    );
  }

  return (
    <div className={FRAME}>
      <p className={MICRO_LABEL}>{title}</p>
      <p className="mt-1 break-words text-[11px] font-semibold text-slate-500">{caption}</p>
      {points.length === 0 ? (
        <p className="mt-2 break-words text-[11px] font-semibold text-slate-500">
          No tablet has reported a position yet. A position arrives with a tablet&rsquo;s check-in once location is on.
        </p>
      ) : (
        <div className="mt-2 space-y-2">
          <div className="h-[320px] border border-slate-100 bg-slate-50 sm:h-[400px]" ref={mapRef} />
          {!ready && !error ? <p className="text-[11px] font-semibold text-slate-500">Loading Google Maps&hellip;</p> : null}
          {error ? <p className="break-words text-[11px] font-bold text-amber-700">{error}</p> : null}
        </div>
      )}
    </div>
  );
}
