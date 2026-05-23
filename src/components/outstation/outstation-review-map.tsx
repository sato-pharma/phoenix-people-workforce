"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Card } from "@/components/ui/card";
import {
  importGoogleLibrary,
  loadGoogleMaps,
  type GoogleMapsApi,
  type GoogleMarkerHandle,
  type GooglePolylineHandle,
} from "@/lib/google-maps/browser";
import {
  buildRoutePreviewKey,
  buildTileRouteMapModel,
  outstationRouteCoordinatesReady,
  safeDecodePolyline,
  selectedRouteForMap,
  selectedRouteForSummary,
} from "@/lib/outstation/route-preview";
import type {
  OutstationCalculationResult,
  OutstationExpenseRequest,
  OutstationRouteAlternative,
} from "@/lib/outstation/types";

type GoogleMapsNamespace = GoogleMapsApi;
type RoutePreviewRequest = OutstationCalculationResult | OutstationExpenseRequest | null;
type StableCoordinateValue = number | null;

function formatMinutes(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "N/A";
  return `${Math.round(value)} mins`;
}

function formatDistance(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "N/A";
  return `${value.toFixed(2)} KM`;
}

function getRequestStatus(request: RoutePreviewRequest) {
  if (!request) return "blocked";
  if ("calculationStatus" in request) return request.calculationStatus;
  return request.status;
}

function buildRoutesForMap(
  routeAlternatives: OutstationRouteAlternative[] | null | undefined,
  routePolyline: string | null | undefined,
  fallbackDistanceKm?: number | null,
  fallbackDurationMinutes?: number | null,
) {
  const alternatives = routeAlternatives?.filter((route) => route.encodedPolyline) ?? [];
  if (alternatives.length > 0) {
    return alternatives;
  }

  return routePolyline
    ? [
        {
          distanceKm: fallbackDistanceKm ?? null,
          durationInTrafficMinutes: null,
          durationMinutes: fallbackDurationMinutes ?? null,
          encodedPolyline: routePolyline,
          index: 0,
          isSelected: true,
          summary: null,
        },
      ]
    : [];
}

function TileRouteMap({
  request,
  route,
}: {
  request: RoutePreviewRequest;
  route: OutstationRouteAlternative | null;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ height: 420, width: 900 });

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const updateSize = () => {
      const bounds = element.getBoundingClientRect();
      if (bounds.width > 0 && bounds.height > 0) {
        setSize({
          height: bounds.height,
          width: bounds.width,
        });
      }
    };

    updateSize();
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  if (!outstationRouteCoordinatesReady(request)) return null;

  const model = buildTileRouteMapModel(request!, route, size);

  return (
    <div
      aria-label="Route map preview"
      className="absolute inset-0 bg-[#e5edf3]"
      ref={containerRef}
      role="img"
    >
      <svg
        className="absolute inset-0 h-full w-full"
        preserveAspectRatio="none"
        viewBox={`0 0 ${model.width} ${model.height}`}
      >
        <defs>
          <pattern height="44" id="route-preview-grid" patternUnits="userSpaceOnUse" width="44">
            <path d="M 44 0 L 0 0 0 44" fill="none" stroke="#cbd5e1" strokeOpacity="0.35" strokeWidth="1" />
          </pattern>
        </defs>
        <rect fill="#e5edf3" height={model.height} width={model.width} x="0" y="0" />
        <rect fill="url(#route-preview-grid)" height={model.height} opacity="0.6" width={model.width} x="0" y="0" />
        {model.tiles.map((tile) => (
          <image
            height="256"
            href={tile.url}
            key={`${tile.url}-${tile.left}-${tile.top}`}
            preserveAspectRatio="none"
            width="256"
            x={tile.left}
            y={tile.top}
          />
        ))}
        <path d={model.path} fill="none" stroke="#fed7aa" strokeLinecap="round" strokeLinejoin="round" strokeWidth="15" />
        <path d={model.path} fill="none" stroke="#f97316" strokeLinecap="round" strokeLinejoin="round" strokeWidth="6" />
        <circle cx={model.residence.x} cy={model.residence.y} fill="#0f172a" r="12" stroke="#ffffff" strokeWidth="4" />
        <circle cx={model.destination.x} cy={model.destination.y} fill="#f97316" r="14" stroke="#ffffff" strokeWidth="4" />
      </svg>
      <div className="absolute bottom-2 right-3 rounded bg-white/85 px-2 py-1 text-[10px] font-semibold text-slate-600 shadow-sm">
        Map data OpenStreetMap contributors
      </div>
    </div>
  );
}

export function OutstationReviewMap({
  request,
}: {
  request: RoutePreviewRequest;
}) {
  const browserKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY ?? "";
  const mapId = process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID ?? "";
  const requestStatus = getRequestStatus(request);
  const residenceLatitude = request?.residenceLatitude ?? null;
  const residenceLongitude = request?.residenceLongitude ?? null;
  const capturedLatitude = request?.capturedLatitude ?? null;
  const capturedLongitude = request?.capturedLongitude ?? null;
  const requestApprovalRecommendation = request?.approvalRecommendation ?? null;
  const requestEligibilityStatus = request?.eligibilityStatus ?? null;
  const requestRouteError = request?.routeError ?? null;

  const mapRef = useRef<HTMLDivElement | null>(null);
  const markersRef = useRef<GoogleMarkerHandle[]>([]);
  const polylinesRef = useRef<GooglePolylineHandle[]>([]);

  const [googleMapsReady, setGoogleMapsReady] = useState(false);
  const [googleMapReadyKey, setGoogleMapReadyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [googleMaps, setGoogleMaps] = useState<GoogleMapsNamespace | null>(null);

  const selectedRoute = selectedRouteForSummary(request);
  const staticRoute = selectedRouteForMap(request);
  const routeAlternatives = request?.routeAlternatives;
  const routePolyline = request?.routePolyline;
  const routeCount = request?.routeAlternatives?.length ?? (request?.routePolyline ? 1 : 0);
  const routesForCurrentRequest = useMemo(
    () =>
      buildRoutesForMap(
        routeAlternatives,
        routePolyline,
        request?.distanceFromResidenceKm,
        request?.durationMinutes,
      ),
    [routeAlternatives, routePolyline, request?.distanceFromResidenceKm, request?.durationMinutes],
  );
  const hasRouteCoordinates =
    request != null &&
    residenceLatitude != null &&
    residenceLongitude != null &&
    Number.isFinite(capturedLatitude) &&
    Number.isFinite(capturedLongitude);
  const routeCollectionSignature = routesForCurrentRequest
    .map((route) => `${route.index}|${route.isSelected ? 1 : 0}|${route.encodedPolyline ?? ""}|${route.distanceKm ?? "na"}|${route.durationMinutes ?? "na"}`)
    .join(";");
  const routePreviewKey = buildRoutePreviewKey(request);
  const routeRenderKey = routePreviewKey
    ? [
      routePreviewKey,
      routeCollectionSignature,
      selectedRoute?.encodedPolyline ?? "no-route",
      requestStatus,
      requestApprovalRecommendation,
      requestEligibilityStatus,
      requestRouteError ?? "no-route-error",
    ].join("|")
    : "";
  const googleMapReady = Boolean(routePreviewKey && googleMapReadyKey === routePreviewKey);
  const googleMapLoading = Boolean(browserKey && googleMapsReady && routePreviewKey && !googleMapReady);

  const clearCurrentMapArtifacts = useCallback(() => {
    markersRef.current.forEach((marker) => {
      if (typeof marker.setMap === "function") {
        marker.setMap(null);
      } else if ("map" in marker) {
        marker.map = null;
      }
    });
    markersRef.current = [];

    polylinesRef.current.forEach((polyline) => polyline.setMap?.(null));
    polylinesRef.current = [];
  }, []);

  useEffect(() => {
    if (!browserKey) return;

    let cancelled = false;

    void loadGoogleMaps(browserKey)
      .then((maps) => {
        if (cancelled) return;
        setGoogleMaps(maps as GoogleMapsNamespace);
        setGoogleMapsReady(true);
      })
      .catch(() => {
        if (cancelled) return;
        setError("Google Maps failed to load. Check browser key referrer restrictions.");
      });

    return () => {
      cancelled = true;
    };
  }, [browserKey]);

  useEffect(() => {
    let cancelled = false;
    const activeRouteRenderKey = routeRenderKey;
    const activeRoutePreviewKey = routePreviewKey;
    let tilesLoadedListener: { remove?: () => void } | undefined;

    const run = async () => {
      clearCurrentMapArtifacts();
      setError(null);
      setGoogleMapReadyKey(null);

      if (
        !googleMapsReady ||
        !routePreviewKey ||
        !googleMaps ||
        !hasRouteCoordinates
      ) {
        return;
      }

      const mapElement = mapRef.current;
      if (!mapElement) return;

        const routes = routesForCurrentRequest;
        const currentResidenceLatitude = residenceLatitude as StableCoordinateValue;
        const currentResidenceLongitude = residenceLongitude as StableCoordinateValue;
        const currentCapturedLatitude = capturedLatitude as StableCoordinateValue;
        const currentCapturedLongitude = capturedLongitude as StableCoordinateValue;

      try {
        const coreLibrary = await importGoogleLibrary(googleMaps, "core", {
          LatLngBounds: googleMaps.LatLngBounds,
        });
        const mapsLibrary = await importGoogleLibrary(googleMaps, "maps", {
          Map: googleMaps.Map,
          Polyline: googleMaps.Polyline,
        });
        const markerLibrary = await importGoogleLibrary(googleMaps, "marker", {
          AdvancedMarkerElement: googleMaps.marker?.AdvancedMarkerElement,
          Marker: googleMaps.Marker,
        });
        if (cancelled || activeRouteRenderKey !== routeRenderKey) return;

        const MapCtor = mapsLibrary?.Map as GoogleMapsNamespace["Map"];
        const useAdvancedMarkers = Boolean(mapId.trim().length > 0);
        const MarkerCtor = useAdvancedMarkers
          ? markerLibrary?.AdvancedMarkerElement as GoogleMapsNamespace["Marker"] ?? googleMaps.marker?.AdvancedMarkerElement
          : markerLibrary?.Marker as GoogleMapsNamespace["Marker"] ?? googleMaps.Marker;
        const LatLngBoundsCtor =
          coreLibrary?.LatLngBounds as GoogleMapsNamespace["LatLngBounds"] ??
          googleMaps.LatLngBounds;
        const PolylineCtor =
          mapsLibrary?.Polyline as GoogleMapsNamespace["Polyline"] ??
          googleMaps.Polyline;

        if (!MapCtor) {
          setError("Google Maps loaded, but the map renderer is unavailable. Refresh the page and retry.");
          setGoogleMapReadyKey(null);
          return;
        }

        clearCurrentMapArtifacts();

        const map = new MapCtor(mapElement, {
          center: {
            lat: (currentResidenceLatitude! + currentCapturedLatitude!) / 2,
            lng: (currentResidenceLongitude! + currentCapturedLongitude!) / 2,
          },
          ...(useAdvancedMarkers ? { mapId } : {}),
          mapTypeControl: false,
          streetViewControl: false,
          zoom: 8,
        });
        setGoogleMapReadyKey(activeRoutePreviewKey);

        tilesLoadedListener = map.addListener?.("tilesloaded", () => {
          if (!cancelled && activeRouteRenderKey === routeRenderKey) {
            setGoogleMapReadyKey(activeRoutePreviewKey);
          }
        });

        if (MarkerCtor) {
          const residenceMarker = new MarkerCtor({
            map,
            position: {
              lat: currentResidenceLatitude!,
              lng: currentResidenceLongitude!,
            },
            title: "Registered residence",
          });
          const capturedMarker = new MarkerCtor({
            map,
            position: {
              lat: currentCapturedLatitude!,
              lng: currentCapturedLongitude!,
            },
            title: "Captured location",
          });
          markersRef.current.push(residenceMarker, capturedMarker);
        }

        const bounds = LatLngBoundsCtor ? new LatLngBoundsCtor() : null;
        bounds?.extend({ lat: currentResidenceLatitude!, lng: currentResidenceLongitude! });
        bounds?.extend({ lat: currentCapturedLatitude!, lng: currentCapturedLongitude! });
        if (bounds) {
          map.fitBounds(bounds, 72);
        }

        if (routes.length === 0) {
          setError("Google Maps did not return a real driving route for this trip yet.");
          setGoogleMapReadyKey(null);
          return;
        }

        routes.forEach((route) => {
          if (!route.encodedPolyline) return;
          const points = safeDecodePolyline(route.encodedPolyline);
          if (points.length < 2) return;
          points.forEach((point) => bounds?.extend(point));
        });
        if (bounds) {
          map.fitBounds(bounds, 72);
        }

        if (!PolylineCtor) {
          setError(null);
          return;
        }

        routes
          .filter((route) => !route.isSelected)
          .forEach((route) => {
            if (!route.encodedPolyline) return;
            const points = safeDecodePolyline(route.encodedPolyline);
            if (points.length > 1) {
              polylinesRef.current.push(new PolylineCtor({
                map,
                path: points,
                strokeColor: "#94a3b8",
                strokeOpacity: 0.45,
                strokeWeight: 4,
                zIndex: 10,
              }));
            }
          });

        routes
          .filter((route) => route.isSelected)
          .forEach((route) => {
            if (!route.encodedPolyline) return;
            const points = safeDecodePolyline(route.encodedPolyline);
            if (points.length > 1) {
              polylinesRef.current.push(new PolylineCtor({
                map,
                path: points,
                strokeColor:
                  requestApprovalRecommendation === "reject"
                    ? "#dc2626"
                    : requestEligibilityStatus === "not_eligible"
                      ? "#f59e0b"
                      : "#f97316",
                strokeOpacity: 0.95,
                strokeWeight: 6,
                zIndex: 20,
              }));
            }
          });

        setError(null);
      } catch (cause) {
        setGoogleMapReadyKey(null);
        setError(cause instanceof Error ? cause.message : "Google Maps could not render this route.");
      }
    };

    void run();
    return () => {
      cancelled = true;
      tilesLoadedListener?.remove?.();
    };
  }, [
    clearCurrentMapArtifacts,
    googleMaps,
    googleMapsReady,
    mapId,
    routeCollectionSignature,
    requestApprovalRecommendation,
    requestEligibilityStatus,
    requestRouteError,
    capturedLatitude,
    capturedLongitude,
    residenceLatitude,
    residenceLongitude,
    hasRouteCoordinates,
    routesForCurrentRequest,
    routePreviewKey,
    routeRenderKey,
  ]);

  return (
    <Card className="rounded-[28px] border border-[#D8E0EA] bg-white/94 p-6 shadow-[0_18px_46px_rgba(15,23,42,0.08)] backdrop-blur">
      <div className="mb-4">
        <p className="text-xs font-black uppercase tracking-[0.16em] text-orange-500">
          Route Review
        </p>
        <h2 className="mt-1 text-xl font-black tracking-[-0.03em] text-slate-950">
          Residence versus captured destination
        </h2>
        <p className="mt-2 text-sm text-slate-600">
          Calculation is based on the fastest available route. Alternative routes are shown for reference only.
        </p>
      </div>

      {outstationRouteCoordinatesReady(request) ? (
        <div className="space-y-3">
          {request ? (
            <div className="grid gap-3 rounded-[22px] border border-[#E2E8F0] bg-[#F8FAFC] p-4 text-sm sm:grid-cols-3">
              <div>
                <p className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Fastest time</p>
                <p className="mt-1 font-bold text-slate-950">
                  {formatMinutes(selectedRoute?.durationInTrafficMinutes ?? selectedRoute?.durationMinutes ?? request.durationMinutes)}
                </p>
              </div>
              <div>
                <p className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Fastest distance</p>
                <p className="mt-1 font-bold text-slate-950">
                  {formatDistance(selectedRoute?.distanceKm ?? request.distanceFromResidenceKm)}
                </p>
              </div>
              <div>
                <p className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Routes found</p>
                <p className="mt-1 font-bold text-slate-950">{routeCount.toLocaleString()}</p>
              </div>
            </div>
          ) : null}
          <div
            className="relative h-[420px] overflow-hidden rounded-[28px] border border-[#E2E8F0] bg-[#F8FAFC] shadow-[inset_0_1px_0_rgba(255,255,255,0.75)]"
          >
            <TileRouteMap request={request} route={staticRoute} />
            {browserKey ? (
              <div
                key={routePreviewKey}
                className={`absolute inset-0 transition-opacity duration-300 ${googleMapReady ? "opacity-100" : "pointer-events-none opacity-0"}`}
                ref={mapRef}
              />
            ) : null}
          </div>
          {googleMapLoading ? (
            <p className="text-sm text-slate-500">
              Loading route map...
            </p>
          ) : null}
          {error ? (
            <p className="text-sm text-amber-700">
              {error}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="rounded-[24px] border border-[#E2E8F0] bg-[#F8FAFC] p-6 text-sm text-slate-600">
          Select a request with both residence and captured coordinates to review the route on the map.
        </div>
      )}
    </Card>
  );
}
