"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

import type { NsmBrickCoverageData } from "@/lib/employee-portal/service";
import { Card } from "@/components/ui/card";
import {
  importGoogleLibrary,
  loadGoogleMaps,
  type GoogleInfoWindowHandle,
  type GoogleMapHandle,
  type GoogleMapsApi,
  type GoogleMarkerHandle,
} from "@/lib/google-maps/browser";

type BrickMapPoint = {
  area: string;
  brick: string;
  status: "unvisited" | "visited";
  visits: number;
};

type GoogleMapsNamespace = GoogleMapsApi;

type MarkerRecord = {
  marker: GoogleMarkerHandle;
  point: BrickMapPoint;
};


function buildQuery(point: BrickMapPoint, lineLabel: string) {
  return [point.brick, point.area, lineLabel, "Egypt"].filter(Boolean).join(", ");
}

function createMarkerIcon(googleMaps: GoogleMapsNamespace, color: string) {
  if (!googleMaps.SymbolPath?.CIRCLE) {
    return undefined;
  }

  return {
    fillColor: color,
    fillOpacity: 1,
    path: googleMaps.SymbolPath.CIRCLE,
    scale: 8,
    strokeColor: "#ffffff",
    strokeWeight: 2,
  };
}

export function BrickCoverageMap({
  data,
}: {
  data: NsmBrickCoverageData;
}) {
  const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY ?? "";
  const mapId = useId().replace(/:/g, "");
  const mapRef = useRef<HTMLDivElement | null>(null);
  const mapInstanceRef = useRef<GoogleMapHandle | null>(null);
  const infoWindowRef = useRef<GoogleInfoWindowHandle | null>(null);
  const markerRecordsRef = useRef<MarkerRecord[]>([]);
  const [googleMaps, setGoogleMaps] = useState<GoogleMapsNamespace | null>(null);
  const [scriptReady, setScriptReady] = useState(false);
  const [scriptFailed, setScriptFailed] = useState(false);
  const [geocodeError, setGeocodeError] = useState<string | null>(null);

  const points: BrickMapPoint[] = useMemo(
    () =>
      data.summary
        ? [
            ...data.summary.visitedBrickRows.map((row) => ({
              area: row.area,
              brick: row.brick,
              status: "visited" as const,
              visits: row.visits,
            })),
            ...data.summary.unvisitedBrickRows.map((row) => ({
              area: row.area,
              brick: row.brick,
              status: "unvisited" as const,
              visits: 0,
            })),
          ]
        : [],
    [data.summary],
  );

  useEffect(() => {
    if (!key) {
      return;
    }

    let cancelled = false;

    void loadGoogleMaps(key)
      .then((maps) => {
        if (cancelled) return;
        setScriptFailed(false);
        setGoogleMaps(maps);
        setScriptReady(true);
      })
      .catch(() => {
        if (cancelled) return;
        setScriptFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [key]);

  useEffect(() => {
    if (!scriptReady || !data.summary || !mapRef.current || !googleMaps) {
      return;
    }

    const mapElement = mapRef.current;
    let cancelled = false;

    const run = async () => {
      const mapsLibrary = await importGoogleLibrary(googleMaps, "maps", { Map: googleMaps.Map });
      const markerLibrary = await importGoogleLibrary(googleMaps, "marker", { Marker: googleMaps.Marker });
      const geocodingLibrary = await importGoogleLibrary(googleMaps, "geocoding", { Geocoder: googleMaps.Geocoder });
      const coreLibrary = await importGoogleLibrary(googleMaps, "core", {
        LatLngBounds: googleMaps.LatLngBounds,
        SymbolPath: googleMaps.SymbolPath,
      });
      if (cancelled) return;

      const MapCtor = mapsLibrary?.Map as GoogleMapsNamespace["Map"] | undefined;
      const GeocoderCtor = geocodingLibrary?.Geocoder as GoogleMapsNamespace["Geocoder"] | undefined;
      const LatLngBoundsCtor =
        coreLibrary?.LatLngBounds as GoogleMapsNamespace["LatLngBounds"] | undefined;
      const MarkerCtor = (markerLibrary?.Marker ?? googleMaps.Marker) as GoogleMapsNamespace["Marker"] | undefined;
      const InfoWindowCtor = googleMaps.InfoWindow;
      const symbolPath = coreLibrary?.SymbolPath as GoogleMapsNamespace["SymbolPath"] | undefined;
      const mapsForIcons: GoogleMapsNamespace = {
        ...googleMaps,
        SymbolPath: symbolPath ?? googleMaps.SymbolPath,
      };

      if (
        !MapCtor ||
        !GeocoderCtor ||
        !MarkerCtor ||
        !InfoWindowCtor
      ) {
        setGeocodeError("Google Maps loaded, but the coverage map tools are unavailable.");
        return;
      }

      const map =
        mapInstanceRef.current ??
        new MapCtor(mapElement, {
          center: { lat: 26.8206, lng: 30.8025 },
          disableDefaultUI: false,
          mapTypeControl: false,
          streetViewControl: false,
          zoom: 6,
        });

      mapInstanceRef.current = map;
      infoWindowRef.current = infoWindowRef.current ?? new InfoWindowCtor();
      markerRecordsRef.current.forEach(({ marker }) => marker.setMap?.(null));
      markerRecordsRef.current = [];
      setGeocodeError(null);

      if (points.length === 0) {
        return;
      }

      const geocoder = new GeocoderCtor();
      const bounds = LatLngBoundsCtor ? new LatLngBoundsCtor() : null;
      let resolvedCount = 0;

      for (const point of points) {
        const query = buildQuery(point, data.scopeLabel);

        try {
          const result = await geocoder.geocode({ address: query });
          const location = result.results[0]?.geometry.location;
          if (!location || cancelled) {
            continue;
          }

          const marker = new MarkerCtor({
            icon: createMarkerIcon(mapsForIcons, point.status === "visited" ? "#16a34a" : "#f97316"),
            map,
            position: location,
            title: point.brick,
          });

          marker.addListener?.("click", () => {
            infoWindowRef.current?.setContent(
              `<div style="min-width:180px;padding:4px 6px">
                <div style="font-weight:700;color:#0f172a">${point.brick}</div>
                <div style="font-size:12px;color:#475569;margin-top:4px">${point.area || "No area"}</div>
                <div style="font-size:12px;color:#475569;margin-top:6px">${
                  point.status === "visited"
                    ? `Visited ${point.visits} time${point.visits === 1 ? "" : "s"}`
                    : "Not visited"
                }</div>
              </div>`,
            );
            infoWindowRef.current?.open({ anchor: marker, map });
          });

          markerRecordsRef.current.push({ marker, point });
          bounds?.extend(location);
          resolvedCount += 1;
        } catch {
          continue;
        }
      }

      if (cancelled) return;

      if (resolvedCount > 0) {
        if (bounds) {
          map.fitBounds(bounds, 56);
        }
      } else {
        setGeocodeError("Google Maps loaded, but none of the selected bricks could be geocoded yet.");
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [data.scopeLabel, data.summary, googleMaps, points, scriptReady]);

  if (!key) {
    return (
      <Card className="rounded-3xl border border-slate-100 bg-white p-6 shadow-[0_12px_24px_rgba(15,23,42,0.05)]">
        <p className="text-sm font-semibold text-slate-900">Map unavailable</p>
        <p className="mt-2 text-sm text-slate-500">
          NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY is missing from the environment.
        </p>
      </Card>
    );
  }

  return (
    <Card className="rounded-3xl border border-slate-100 bg-white p-6 shadow-[0_12px_24px_rgba(15,23,42,0.05)]">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
            Coverage Map
          </p>
          <h2 className="mt-1 text-lg font-semibold text-slate-900">
            Brick locations for {data.summary?.selectedDsmName ?? "the selected DSM"}
          </h2>
        </div>

        <div className="flex items-center gap-4 text-xs font-medium text-slate-600">
          <span className="inline-flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-green-600" />
            Visited
          </span>
          <span className="inline-flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-orange-500" />
            Not visited
          </span>
        </div>
      </div>

      <div
        className="h-[420px] overflow-hidden rounded-3xl border border-slate-200 bg-slate-50"
        id={`brick-coverage-map-${mapId}`}
        ref={mapRef}
      />

      {scriptFailed ? (
        <p className="mt-3 text-sm text-rose-600">
          Google Maps failed to load. Check API restrictions and allowed referrers.
        </p>
      ) : null}
      {geocodeError ? <p className="mt-3 text-sm text-amber-600">{geocodeError}</p> : null}
    </Card>
  );
}
