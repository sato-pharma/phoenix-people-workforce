"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { AdminCallout } from "@/components/admin/admin-design-system";
import { compactEgp, egp } from "@/components/outstation/expense-shared/formatters";
import {
  importGoogleLibrary,
  loadGoogleMaps,
  type GoogleHeatmapLayerHandle,
  type GoogleInfoWindowHandle,
  type GoogleLatLngBoundsHandle,
  type GoogleMapHandle,
  type GoogleMapsApi,
  type GoogleMarkerHandle,
} from "@/lib/google-maps/browser";

export type ExpenseHeatPointInput = {
  id: string | number;
  lat: number;
  lng: number;
  weight: number;
  employeeName?: string;
  region?: string | null;
  city?: string | null;
  line?: string | null;
  status?: string | null;
  source?: string | null;
};

type HeatmapMode = "heat" | "markers" | "both";

type MapsLibrary = {
  HeatmapLayer?: NonNullable<NonNullable<GoogleMapsApi["visualization"]>["HeatmapLayer"]>;
  InfoWindow?: NonNullable<GoogleMapsApi["InfoWindow"]>;
  LatLng?: NonNullable<GoogleMapsApi["LatLng"]>;
  LatLngBounds?: new () => GoogleLatLngBoundsHandle;
  Map?: NonNullable<GoogleMapsApi["Map"]>;
  Marker?: NonNullable<GoogleMapsApi["Marker"]>;
};

const EGYPT_CENTER = { lat: 26.8206, lng: 30.8025 };
const HEAT_GRADIENT = [
  "rgba(249, 115, 22, 0)",
  "rgba(251, 191, 36, 0.55)",
  "rgba(249, 115, 22, 0.8)",
  "rgba(234, 88, 12, 0.95)",
  "rgba(154, 52, 18, 1)",
];

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function infoContent(point: ExpenseHeatPointInput): string {
  const lines: string[] = [];
  lines.push(
    `<div style="font-weight:800;color:#0F172A;font-size:13px">${escapeHtml(point.employeeName ?? "Unknown")}</div>`,
  );
  const place = [point.region, point.city].filter(Boolean).join(" · ");
  if (place) lines.push(`<div style="color:#475569;font-size:12px">${escapeHtml(place)}</div>`);
  lines.push(
    `<div style="margin-top:4px;color:#C2410C;font-weight:800;font-size:12px">${escapeHtml(egp(point.weight))}</div>`,
  );
  const meta = [point.status, point.source].filter(Boolean).join(" · ");
  if (meta) lines.push(`<div style="color:#64748B;font-size:11px">${escapeHtml(meta)}</div>`);
  return `<div style="min-width:160px;font-family:system-ui,-apple-system,sans-serif">${lines.join("")}</div>`;
}

export function ExpenseHeatmapLayer({
  points,
  browserKey,
  height = 520,
  initialMode = "both",
  unmappedCount = 0,
  unmappedAmount = 0,
  onSelectPoint,
  title = "Expense concentration",
  subtitle = "Spend-weighted destination activity across the company.",
}: {
  points: ExpenseHeatPointInput[];
  browserKey: string;
  height?: number;
  initialMode?: HeatmapMode;
  unmappedCount?: number;
  unmappedAmount?: number;
  onSelectPoint?: (point: ExpenseHeatPointInput) => void;
  title?: string;
  subtitle?: string;
}) {
  const mapRef = useRef<HTMLDivElement | null>(null);
  const mapInstanceRef = useRef<GoogleMapHandle | null>(null);
  const markersRef = useRef<GoogleMarkerHandle[]>([]);
  const heatLayerRef = useRef<GoogleHeatmapLayerHandle | null>(null);
  const infoWindowRef = useRef<GoogleInfoWindowHandle | null>(null);
  const modeRef = useRef<HeatmapMode>(initialMode);

  const [googleMaps, setGoogleMaps] = useState<GoogleMapsApi | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [heatmapAvailable, setHeatmapAvailable] = useState(true);
  const [mode, setMode] = useState<HeatmapMode>(initialMode);

  modeRef.current = mode;

  const onSelectRef = useRef(onSelectPoint);
  onSelectRef.current = onSelectPoint;

  // Load Google Maps once.
  useEffect(() => {
    if (!browserKey) return;
    let cancelled = false;
    void loadGoogleMaps(browserKey)
      .then((maps) => {
        if (cancelled) return;
        setError(null);
        setGoogleMaps(maps as GoogleMapsApi);
        setReady(true);
      })
      .catch((cause) => {
        if (cancelled) return;
        setReady(false);
        setError(cause instanceof Error ? cause.message : "Google Maps could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
  }, [browserKey]);

  // A Maps auth failure (e.g. the API key's allowed-referrer list doesn't include
  // this domain) can fire AFTER the script loads, when the map paints. Surface an
  // honest message instead of Google's bare "Oops" overlay plus a misleading
  // "showing markers" note (there are no markers — the whole map failed).
  useEffect(() => {
    if (!browserKey) return;
    const previous = window.gm_authFailure;
    window.gm_authFailure = () => {
      previous?.();
      setReady(false);
      setHeatmapAvailable(true);
      setError(
        "Google Maps is not authorized for this domain. Check the API key's allowed referrers — the map renders on the production domain.",
      );
    };
    return () => {
      window.gm_authFailure = previous;
    };
  }, [browserKey]);

  // Build map + markers + heat layer whenever the point set changes.
  useEffect(() => {
    const mapElement = mapRef.current;
    if (!ready || !mapElement || !googleMaps) return;

    let cancelled = false;

    const run = async () => {
      const mapsLibrary = await importGoogleLibrary<MapsLibrary>(googleMaps, "maps", {
        Map: googleMaps.Map,
        InfoWindow: googleMaps.InfoWindow,
      });
      const markerLibrary = await importGoogleLibrary<MapsLibrary>(googleMaps, "marker", {
        Marker: googleMaps.Marker,
      });
      const coreLibrary = await importGoogleLibrary<MapsLibrary>(googleMaps, "core", {
        LatLng: googleMaps.LatLng,
        LatLngBounds: googleMaps.LatLngBounds,
      });

      let visualizationLibrary: MapsLibrary = {};
      let heatAvailable = true;
      try {
        visualizationLibrary = await importGoogleLibrary<MapsLibrary>(googleMaps, "visualization", {});
        if (!visualizationLibrary.HeatmapLayer && !googleMaps.visualization?.HeatmapLayer) {
          heatAvailable = false;
        }
      } catch {
        heatAvailable = false;
      }
      if (cancelled) return;

      const mapCtor = mapsLibrary.Map ?? googleMaps.Map;
      const markerCtor = markerLibrary.Marker ?? mapsLibrary.Marker ?? googleMaps.Marker;
      const latLngBoundsCtor = coreLibrary.LatLngBounds ?? mapsLibrary.LatLngBounds ?? googleMaps.LatLngBounds;
      const latLngCtor = coreLibrary.LatLng ?? googleMaps.LatLng;
      const infoWindowCtor = mapsLibrary.InfoWindow ?? googleMaps.InfoWindow;
      const heatmapCtor = visualizationLibrary.HeatmapLayer ?? googleMaps.visualization?.HeatmapLayer;
      if (!mapCtor || !markerCtor || !latLngBoundsCtor) return;

      const map =
        mapInstanceRef.current ??
        new mapCtor(mapElement, {
          center: EGYPT_CENTER,
          mapTypeControl: false,
          streetViewControl: false,
          zoom: 6,
        });
      mapInstanceRef.current = map;

      if (!infoWindowRef.current && infoWindowCtor) {
        infoWindowRef.current = new infoWindowCtor();
      }

      // Reset previous markers + heat.
      markersRef.current.forEach((marker) => marker.setMap?.(null));
      markersRef.current = [];
      heatLayerRef.current?.setMap(null);
      heatLayerRef.current = null;

      const bounds = new latLngBoundsCtor();
      points.forEach((point) => {
        const marker = new markerCtor({
          map,
          position: { lat: point.lat, lng: point.lng },
          title: point.employeeName ?? "",
        });
        marker.addListener?.("click", () => {
          const info = infoWindowRef.current;
          if (info) {
            info.setContent(infoContent(point));
            info.open({ anchor: marker, map });
          }
          onSelectRef.current?.(point);
        });
        markersRef.current.push(marker);
        bounds.extend({ lat: point.lat, lng: point.lng });
      });

      if (heatAvailable && heatmapCtor && latLngCtor && points.length > 0) {
        try {
          heatLayerRef.current = new heatmapCtor({
            data: points.map((point) => ({
              location: new latLngCtor(point.lat, point.lng),
              weight: Math.max(0, point.weight),
            })),
            dissipating: true,
            gradient: HEAT_GRADIENT,
            opacity: 0.85,
            radius: 28,
          });
        } catch {
          heatAvailable = false;
        }
      }

      setHeatmapAvailable(heatAvailable);
      if (!heatAvailable && modeRef.current !== "markers") {
        modeRef.current = "markers";
        setMode("markers");
      }

      applyVisibility(modeRef.current);

      if (points.length > 0) {
        map.fitBounds(bounds);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [points, googleMaps, ready]);

  // Apply heat/marker visibility on mode change without rebuilding the map.
  function applyVisibility(nextMode: HeatmapMode) {
    const map = mapInstanceRef.current;
    if (!map) return;
    markersRef.current.forEach((marker) => marker.setMap?.(nextMode === "heat" ? null : map));
    heatLayerRef.current?.setMap(nextMode === "markers" ? null : map);
  }

  useEffect(() => {
    applyVisibility(mode);
  }, [mode]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      markersRef.current.forEach((marker) => marker.setMap?.(null));
      markersRef.current = [];
      heatLayerRef.current?.setMap(null);
      heatLayerRef.current = null;
    };
  }, []);

  const modeOptions = useMemo(
    () =>
      (["heat", "markers", "both"] as HeatmapMode[]).map((value) => ({
        value,
        label: value === "heat" ? "Heat" : value === "markers" ? "Markers" : "Both",
        disabled: value !== "markers" && !heatmapAvailable,
      })),
    [heatmapAvailable],
  );

  const hasPoints = points.length > 0;

  return (
    <div className="overflow-hidden rounded-[18px] border border-[#D8E0EA] bg-white shadow-[0_18px_46px_rgba(15,23,42,0.08)]">
      <div className="relative overflow-hidden border-b border-[#1F2937] bg-[radial-gradient(circle_at_top_right,rgba(249,115,22,0.24),transparent_34%),linear-gradient(135deg,#080B10_0%,#111827_58%,#24150D_100%)] px-5 py-5 text-white">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-16 -top-20 h-44 w-44 rounded-full bg-[#F97316]/20 blur-3xl"
        />
        <div className="relative z-10 flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="inline-flex rounded-full border border-[#F97316]/35 bg-[#F97316]/12 px-3 py-1 text-xs font-black uppercase tracking-[0.16em] text-[#FDBA74]">
              Geographic Intelligence
            </p>
            <h2 className="mt-3 text-xl font-black tracking-[-0.03em] text-white">{title}</h2>
            <p className="mt-1 text-sm text-[#CBD5E1]">{subtitle}</p>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#CBD5E1]">
              <span>Low</span>
              <span
                aria-hidden="true"
                className="h-2 w-24 rounded-full"
                style={{ background: "linear-gradient(90deg, #FBBF24 0%, #F97316 55%, #9A3412 100%)" }}
              />
              <span>High</span>
            </div>
            <div className="flex overflow-hidden rounded-full border border-white/15 bg-white/[0.06]">
              {modeOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  disabled={option.disabled}
                  onClick={() => setMode(option.value)}
                  className={`px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.12em] transition-colors ${
                    mode === option.value
                      ? "bg-[#F97316] text-white"
                      : option.disabled
                        ? "cursor-not-allowed text-white/25"
                        : "text-[#CBD5E1] hover:bg-white/10"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-3 p-5">
        <div
          className="flex items-center justify-center rounded-[14px] border border-[#DDE6F1] bg-[#F8FAFC] p-6 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.75)]"
          ref={mapRef}
          style={{ height }}
        >
          {!browserKey ? (
            <div>
              <p className="text-sm font-black text-[#0F172A]">Map unavailable</p>
              <p className="mt-2 max-w-xl text-sm leading-6 text-[#64748B]">
                NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY is missing from the environment.
              </p>
            </div>
          ) : error ? (
            <div>
              <p className="text-sm font-black text-[#0F172A]">Google Maps unavailable</p>
              <p className="mt-2 max-w-xl text-sm leading-6 text-[#64748B]">{error}</p>
            </div>
          ) : !ready ? (
            <p className="text-sm font-semibold text-[#64748B]">Loading Google Maps…</p>
          ) : !hasPoints ? (
            <p className="text-sm font-semibold text-[#64748B]">No mappable expenses for these filters.</p>
          ) : null}
        </div>

        {browserKey && ready && !error && !heatmapAvailable ? (
          <AdminCallout tone="warning">
            <span>
              Heat layer is unavailable on this Maps key — showing clickable markers instead. Totals and
              analytics are unaffected.
            </span>
          </AdminCallout>
        ) : null}

        {unmappedCount > 0 ? (
          <AdminCallout tone="warning">
            <span>
              <strong>{unmappedCount.toLocaleString()}</strong> expense row{unmappedCount === 1 ? "" : "s"}
              {unmappedAmount > 0 ? ` (${egp(unmappedAmount)})` : ""} have no resolved coordinates and are not
              shown on the map. They remain in every KPI, chart, table, and the export — only the map view is
              partial. Mappable spend shown: {compactEgp(points.reduce((sum, point) => sum + point.weight, 0))}.
            </span>
          </AdminCallout>
        ) : null}
      </div>
    </div>
  );
}
