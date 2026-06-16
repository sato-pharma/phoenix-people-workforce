"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { AdminCallout } from "@/components/admin/admin-design-system";
import { compactEgp, egp } from "@/components/outstation/expense-shared/formatters";
import {
  importGoogleLibrary,
  loadGoogleMaps,
  type GoogleInfoWindowHandle,
  type GoogleLatLngBoundsHandle,
  type GoogleMapHandle,
  type GoogleMapsApi,
  type GoogleMarkerHandle,
} from "@/lib/google-maps/browser";

export type ExpenseBubbleInput = {
  id: string | number;
  lat: number;
  lng: number;
  weight: number; // total spend for the region
  region?: string | null;
  count?: number;
};

type MapsLibrary = {
  InfoWindow?: NonNullable<GoogleMapsApi["InfoWindow"]>;
  LatLngBounds?: new () => GoogleLatLngBoundsHandle;
  Map?: NonNullable<GoogleMapsApi["Map"]>;
  Marker?: NonNullable<GoogleMapsApi["Marker"]>;
};

const EGYPT_CENTER = { lat: 26.8206, lng: 30.8025 };

// Low → high spend colour ramp for the dots.
const RAMP = ["#FDBA74", "#FB923C", "#F97316", "#EA580C", "#C2410C", "#9A3412"];

// Uniform dot size — clear, even markers (no confusing variable bubbles). Spend is
// conveyed by colour and the click popover, not size.
const DOT_SCALE = 6.5;

function colorFor(ratio: number): string {
  const index = Math.min(RAMP.length - 1, Math.max(0, Math.round(ratio * (RAMP.length - 1))));
  return RAMP[index];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function infoContent(point: ExpenseBubbleInput): string {
  const region = escapeHtml(point.region ?? "Unassigned");
  const trips = point.count ? `${point.count.toLocaleString()} trip${point.count === 1 ? "" : "s"}` : "";
  return `<div style="min-width:150px;font-family:system-ui,-apple-system,sans-serif">
    <div style="font-weight:800;color:#0F172A;font-size:13px">${region}</div>
    <div style="margin-top:3px;color:#C2410C;font-weight:800;font-size:13px">${escapeHtml(egp(point.weight))}</div>
    ${trips ? `<div style="color:#64748B;font-size:11px">${escapeHtml(trips)}</div>` : ""}
  </div>`;
}

export function ExpenseHeatmapLayer({
  points,
  browserKey,
  height = 520,
  unmappedCount = 0,
  unmappedAmount = 0,
  title = "Expense concentration",
  subtitle = "Each dot is a destination — colour shows total spend (light = low, dark = high).",
}: {
  points: ExpenseBubbleInput[];
  browserKey: string;
  height?: number;
  unmappedCount?: number;
  unmappedAmount?: number;
  title?: string;
  subtitle?: string;
}) {
  const mapRef = useRef<HTMLDivElement | null>(null);
  const mapInstanceRef = useRef<GoogleMapHandle | null>(null);
  const markersRef = useRef<GoogleMarkerHandle[]>([]);
  const infoWindowRef = useRef<GoogleInfoWindowHandle | null>(null);

  const [googleMaps, setGoogleMaps] = useState<GoogleMapsApi | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const maxWeight = useMemo(
    () => points.reduce((peak, point) => Math.max(peak, point.weight), 0) || 1,
    [points],
  );
  const mappedSpend = useMemo(() => points.reduce((sum, point) => sum + point.weight, 0), [points]);

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

  // A late Maps auth failure (key not authorized for this domain) → honest message.
  useEffect(() => {
    if (!browserKey) return;
    const previous = window.gm_authFailure;
    window.gm_authFailure = () => {
      previous?.();
      setReady(false);
      setError(
        "Google Maps is not authorized for this domain. Check the API key's allowed referrers — the map renders on the production domain.",
      );
    };
    return () => {
      window.gm_authFailure = previous;
    };
  }, [browserKey]);

  // Build / refresh the bubbles whenever the point set changes.
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
        LatLngBounds: googleMaps.LatLngBounds,
      });
      if (cancelled) return;

      const mapCtor = mapsLibrary.Map ?? googleMaps.Map;
      const markerCtor = markerLibrary.Marker ?? mapsLibrary.Marker ?? googleMaps.Marker;
      const latLngBoundsCtor = coreLibrary.LatLngBounds ?? mapsLibrary.LatLngBounds ?? googleMaps.LatLngBounds;
      const infoWindowCtor = mapsLibrary.InfoWindow ?? googleMaps.InfoWindow;
      const circlePath = googleMaps.SymbolPath?.CIRCLE ?? 0;
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

      markersRef.current.forEach((marker) => marker.setMap?.(null));
      markersRef.current = [];

      const bounds = new latLngBoundsCtor();
      // Largest bubbles first so smaller ones stay clickable on top.
      [...points]
        .sort((a, b) => b.weight - a.weight)
        .forEach((point) => {
          const ratio = point.weight / maxWeight;
          const marker = new markerCtor({
            map,
            position: { lat: point.lat, lng: point.lng },
            title: `${point.region ?? "Unassigned"} · ${egp(point.weight)}`,
            zIndex: Math.round(point.weight),
            icon: {
              path: circlePath,
              scale: DOT_SCALE,
              fillColor: colorFor(ratio),
              fillOpacity: 0.95,
              strokeColor: "#FFFFFF",
              strokeWeight: 1.2,
            },
          });
          marker.addListener?.("click", () => {
            const info = infoWindowRef.current;
            if (info) {
              info.setContent(infoContent(point));
              info.open({ anchor: marker, map });
            }
          });
          markersRef.current.push(marker);
          bounds.extend({ lat: point.lat, lng: point.lng });
        });

      if (points.length > 0) {
        map.fitBounds(bounds);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [points, googleMaps, ready, maxWeight]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      markersRef.current.forEach((marker) => marker.setMap?.(null));
      markersRef.current = [];
    };
  }, []);

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
          <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#CBD5E1]">
            <span>Low</span>
            <span
              aria-hidden="true"
              className="h-2.5 w-28 rounded-full"
              style={{ background: "linear-gradient(90deg, #FED7AA 0%, #F97316 55%, #9A3412 100%)" }}
            />
            <span>High</span>
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

        {unmappedCount > 0 ? (
          <AdminCallout tone="warning">
            <span>
              <strong>{unmappedCount.toLocaleString()}</strong> expense row{unmappedCount === 1 ? "" : "s"}
              {unmappedAmount > 0 ? ` (${egp(unmappedAmount)})` : ""} have no resolved location and aren&apos;t shown
              on the map. They remain in every KPI, chart, table, and the export. Mapped spend shown:{" "}
              {compactEgp(mappedSpend)} across {points.length} location{points.length === 1 ? "" : "s"}.
            </span>
          </AdminCallout>
        ) : null}
      </div>
    </div>
  );
}
