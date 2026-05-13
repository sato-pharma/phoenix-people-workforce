"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { Card } from "@/components/ui/card";
import type { GeoTripRouteRecord } from "@/lib/geo-intelligence/types";
import {
  importGoogleLibrary,
  loadGoogleMaps,
  type GoogleMapHandle,
  type GoogleMapsApi,
} from "@/lib/google-maps/browser";
import { formatEmployeeDisplayName } from "@/lib/utils";

function egp(value: number) {
  return new Intl.NumberFormat("en-US", {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(value);
}

type GoogleDirectionsRendererHandle = {
  setDirections: (result: unknown) => void;
  setMap?: (map: unknown | null) => void;
};

type GoogleMapsNamespace = GoogleMapsApi & {
  DirectionsRenderer?: new (options: Record<string, unknown>) => {
    setDirections: (result: unknown) => void;
    setMap?: (map: unknown | null) => void;
  };
  DirectionsService?: new () => {
    route: (
      request: Record<string, unknown>,
      callback: (result: unknown, status: string) => void,
    ) => void;
  };
  TravelMode?: { DRIVING: unknown };
};

type GoogleRoutesLibrary = {
  DirectionsRenderer?: GoogleMapsNamespace["DirectionsRenderer"];
  DirectionsService?: GoogleMapsNamespace["DirectionsService"];
  TravelMode?: GoogleMapsNamespace["TravelMode"];
};

export function ExpenseRouteMap({ routes }: { routes: GeoTripRouteRecord[] }) {
  const browserKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY ?? "";
  const [googleMaps, setGoogleMaps] = useState<GoogleMapsNamespace | null>(null);
  const [ready, setReady] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(routes[0]?.id ?? null);
  const mapRef = useRef<HTMLDivElement | null>(null);
  const mapInstanceRef = useRef<GoogleMapHandle | null>(null);
  const rendererRef = useRef<GoogleDirectionsRendererHandle | null>(null);
  const selectedRoute = useMemo(
    () => routes.find((route) => route.id === selectedId) ?? routes[0] ?? null,
    [routes, selectedId],
  );

  useEffect(() => {
    if (!browserKey) return;

    let cancelled = false;
    void loadGoogleMaps(browserKey)
      .then((maps) => {
        if (cancelled) return;
        setGoogleMaps(maps as GoogleMapsNamespace);
        setReady(true);
      })
      .catch(() => setReady(false));

    return () => {
      cancelled = true;
    };
  }, [browserKey]);

  useEffect(() => {
    const mapElement = mapRef.current;
    if (!ready || !mapElement || !googleMaps || !selectedRoute) return;
    if (
      selectedRoute.fromLat == null ||
      selectedRoute.fromLng == null ||
      selectedRoute.toLat == null ||
      selectedRoute.toLng == null
    ) {
      return;
    }

    let cancelled = false;
    const run = async () => {
      const mapsLibrary = await importGoogleLibrary(googleMaps, "maps", { Map: googleMaps.Map });
      const routesLibrary: GoogleRoutesLibrary = await importGoogleLibrary(googleMaps, "routes", {
        DirectionsRenderer: googleMaps.DirectionsRenderer,
        DirectionsService: googleMaps.DirectionsService,
        TravelMode: googleMaps.TravelMode,
      });
      if (cancelled) return;

      const MapCtor = mapsLibrary.Map as GoogleMapsNamespace["Map"] | undefined;
      const DirectionsServiceCtor = (routesLibrary.DirectionsService ?? googleMaps.DirectionsService) as GoogleMapsNamespace["DirectionsService"] | undefined;
      const DirectionsRendererCtor = (routesLibrary.DirectionsRenderer ?? googleMaps.DirectionsRenderer) as GoogleMapsNamespace["DirectionsRenderer"] | undefined;
      const TravelMode = routesLibrary.TravelMode ?? googleMaps.TravelMode;

      if (!MapCtor || !DirectionsServiceCtor || !DirectionsRendererCtor || !TravelMode?.DRIVING) {
        return;
      }

      const map =
        mapInstanceRef.current ??
        new MapCtor(mapElement, {
          center: { lat: selectedRoute.fromLat, lng: selectedRoute.fromLng },
          mapTypeControl: false,
          streetViewControl: false,
          zoom: 8,
        });

      mapInstanceRef.current = map;
      rendererRef.current?.setMap?.(null);
      const renderer = new DirectionsRendererCtor({
        map,
        polylineOptions: {
          strokeColor: "#f97316",
          strokeOpacity: 0.9,
          strokeWeight: 5,
        },
        suppressMarkers: false,
      });
      rendererRef.current = renderer;

      const directions = new DirectionsServiceCtor();
      directions.route(
        {
          destination: { lat: selectedRoute.toLat, lng: selectedRoute.toLng },
          origin: { lat: selectedRoute.fromLat, lng: selectedRoute.fromLng },
          travelMode: TravelMode.DRIVING,
        },
        (result: unknown, status: string) => {
          if (cancelled || status !== "OK") return;
          renderer.setDirections(result);
        },
      );
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [googleMaps, ready, selectedRoute]);

  return (
    <Card className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_18px_40px_rgba(15,23,42,0.06)]">
      <div className="mb-5 flex items-end justify-between gap-4">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.16em] text-orange-500">
            Expense routes
          </p>
          <h2 className="mt-1 text-xl font-black tracking-[-0.03em] text-slate-950">
            Route validation and trip playback
          </h2>
        </div>
        <select
          className="h-10 max-w-[360px] rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-800"
          onChange={(event) => setSelectedId(Number(event.target.value))}
          value={selectedRoute?.id ?? ""}
        >
          {routes.map((route) => (
            <option key={route.id} value={route.id}>
              {formatEmployeeDisplayName(route.employeeName, "Unknown")} | {route.fromText} to {route.toText}
            </option>
          ))}
        </select>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="h-[520px] rounded-3xl border border-slate-200 bg-slate-50" ref={mapRef} />
        <div className="rounded-3xl border border-slate-200 bg-slate-50 p-4">
          {selectedRoute ? (
            <div className="space-y-3">
              <Stat label="Employee" value={formatEmployeeDisplayName(selectedRoute.employeeName, "Unknown")} />
              <Stat label="From" value={selectedRoute.fromText} />
              <Stat label="To" value={selectedRoute.toText} />
              <Stat label="Claimed" value={egp(selectedRoute.claimedAmount)} />
              <Stat label="Expected" value={egp(selectedRoute.expectedAmount)} />
              <Stat
                label="Variance"
                value={`${egp(selectedRoute.varianceAmount)} (${selectedRoute.variancePercent.toFixed(1)}%)`}
              />
            </div>
          ) : (
            <p className="text-sm text-slate-500">No route selected.</p>
          )}
        </div>
      </div>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-3">
      <p className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <p className="mt-1 text-sm font-semibold text-slate-900">{value}</p>
    </div>
  );
}
