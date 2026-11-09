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
  // Optional approval-split fields. When present they let the map split bubbles by
  // approval status via the All / Approved / Pending pill in the header.
  approvedWeight?: number;
  pendingWeight?: number;
  approvedCount?: number;
  pendingCount?: number;
};

type BubbleMode = "all" | "approved" | "pending";

const MODE_OPTIONS: ReadonlyArray<{ value: BubbleMode; label: string }> = [
  { value: "all", label: "All" },
  { value: "approved", label: "Approved" },
  { value: "pending", label: "Pending" },
];

type MapsLibrary = {
  InfoWindow?: NonNullable<GoogleMapsApi["InfoWindow"]>;
  LatLngBounds?: new () => GoogleLatLngBoundsHandle;
  Map?: NonNullable<GoogleMapsApi["Map"]>;
  Marker?: NonNullable<GoogleMapsApi["Marker"]>;
};

const EGYPT_CENTER = { lat: 26.8206, lng: 30.8025 };

// Low → high spend colour ramps. Orange for All / Approved, amber for Pending so the
// two modes are immediately distinguishable at a glance.
const RAMP_ORANGE = ["#FDBA74", "#FB923C", "#F97316", "#EA580C", "#C2410C", "#9A3412"];
const RAMP_AMBER = ["#FDE68A", "#FCD34D", "#F59E0B", "#D97706", "#B45309", "#78350F"];

// Uniform dot size — clear, even markers (no confusing variable bubbles). Spend is
// conveyed by colour and the click popover, not size.
const DOT_SCALE = 6.5;

function colorFor(ratio: number, mode: BubbleMode): string {
  const ramp = mode === "pending" ? RAMP_AMBER : RAMP_ORANGE;
  const index = Math.min(ramp.length - 1, Math.max(0, Math.round(ratio * (ramp.length - 1))));
  return ramp[index];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function infoContent(point: ExpenseBubbleInput, mode: BubbleMode): string {
  const region = escapeHtml(point.region ?? "Unassigned");
  const amount =
    mode === "approved" ? point.approvedWeight ?? 0
    : mode === "pending" ? point.pendingWeight ?? 0
    : point.weight;
  const tripCount =
    mode === "approved" ? point.approvedCount ?? 0
    : mode === "pending" ? point.pendingCount ?? 0
    : point.count ?? 0;
  const amountColor = mode === "pending" ? "#92400E" : "#C2410C";
  const trips = tripCount ? `${tripCount.toLocaleString()} trip${tripCount === 1 ? "" : "s"}` : "";
  const modeLine =
    mode === "all" && (point.approvedWeight !== undefined || point.pendingWeight !== undefined)
      ? `<div style="margin-top:4px;color:#64748B;font-size:11px">Approved ${escapeHtml(egp(point.approvedWeight ?? 0))} · Pending ${escapeHtml(egp(point.pendingWeight ?? 0))}</div>`
      : "";
  return `<div style="min-width:150px;font-family:system-ui,-apple-system,sans-serif">
    <div style="font-weight:800;color:#0F172A;font-size:13px">${region}</div>
    <div style="margin-top:3px;color:${amountColor};font-weight:800;font-size:13px">${escapeHtml(egp(amount))}</div>
    ${trips ? `<div style="color:#64748B;font-size:11px">${escapeHtml(trips)}</div>` : ""}
    ${modeLine}
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
  const [mode, setMode] = useState<BubbleMode>("all");

  // Show only the approval-split toggle if at least one bubble carries the split data
  // (otherwise the toggle would be meaningless for the rows on the map).
  const supportsApprovalSplit = useMemo(
    () => points.some((point) => point.approvedWeight !== undefined || point.pendingWeight !== undefined),
    [points],
  );

  const weightFor = (point: ExpenseBubbleInput): number => {
    if (mode === "approved") return point.approvedWeight ?? 0;
    if (mode === "pending") return point.pendingWeight ?? 0;
    return point.weight;
  };

  // Points that contribute to the active mode — anything with zero weight in this
  // mode (e.g. an all-approved bubble in "Pending" view) is filtered out entirely.
  const displayPoints = useMemo(
    () => points.filter((point) => weightFor(point) > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [points, mode],
  );

  const maxWeight = useMemo(
    () => displayPoints.reduce((peak, point) => Math.max(peak, weightFor(point)), 0) || 1,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [displayPoints, mode],
  );
  const mappedSpend = useMemo(
    () => displayPoints.reduce((sum, point) => sum + weightFor(point), 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [displayPoints, mode],
  );

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
      [...displayPoints]
        .sort((a, b) => weightFor(b) - weightFor(a))
        .forEach((point) => {
          const value = weightFor(point);
          const ratio = value / maxWeight;
          const marker = new markerCtor({
            map,
            position: { lat: point.lat, lng: point.lng },
            title: `${point.region ?? "Unassigned"} · ${egp(value)}`,
            zIndex: Math.round(value),
            icon: {
              path: circlePath,
              scale: DOT_SCALE,
              fillColor: colorFor(ratio, mode),
              fillOpacity: 0.95,
              strokeColor: "#FFFFFF",
              strokeWeight: 1.2,
            },
          });
          marker.addListener?.("click", () => {
            const info = infoWindowRef.current;
            if (info) {
              info.setContent(infoContent(point, mode));
              info.open({ anchor: marker, map });
            }
          });
          markersRef.current.push(marker);
          bounds.extend({ lat: point.lat, lng: point.lng });
        });

      if (displayPoints.length === 1) {
        // A single bubble → fitBounds on a zero-area bounds zooms to building level on a
        // region centroid, which looks broken. Centre it at a region-appropriate zoom.
        map.setCenter?.({ lat: displayPoints[0].lat, lng: displayPoints[0].lng });
        map.setZoom?.(9);
      } else if (displayPoints.length > 1) {
        map.fitBounds(bounds);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayPoints, googleMaps, ready, maxWeight, mode]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      markersRef.current.forEach((marker) => marker.setMap?.(null));
      markersRef.current = [];
    };
  }, []);

  const hasPoints = displayPoints.length > 0;
  const legendGradient =
    mode === "pending"
      ? "linear-gradient(90deg, #FDE68A 0%, #F59E0B 55%, #78350F 100%)"
      : "linear-gradient(90deg, #FED7AA 0%, #F97316 55%, #9A3412 100%)";

  return (
    <div className="overflow-hidden rounded-[18px] border border-phx-line bg-white shadow-[0_18px_46px_rgba(15,23,42,0.08)]">
      <div className="relative overflow-hidden border-b border-[#1F2937] bg-[radial-gradient(circle_at_top_right,rgba(249,115,22,0.24),transparent_34%),linear-gradient(135deg,#080B10_0%,#111827_58%,#24150D_100%)] px-5 py-5 text-white">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-16 -top-20 h-44 w-44 rounded-full bg-phx-accent/20 blur-3xl"
        />
        <div className="relative z-10 flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="inline-flex rounded-full border border-phx-accent/35 bg-phx-accent/12 px-3 py-1 text-xs font-black uppercase tracking-[0.16em] text-phx-accent">
              Geographic Intelligence
            </p>
            <h2 className="mt-3 text-xl font-black tracking-[-0.03em] text-white">{title}</h2>
            <p className="mt-1 text-sm text-phx-line-strong">{subtitle}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {supportsApprovalSplit ? (
              <div className="flex overflow-hidden rounded-full border border-white/15 bg-white/[0.06]">
                {MODE_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    className={`px-3 py-1 text-phx-sm font-bold uppercase tracking-[0.14em] transition-colors ${
                      mode === option.value ? "bg-phx-accent text-white" : "text-phx-line-strong hover:text-white"
                    }`}
                    onClick={() => setMode(option.value)}
                    type="button"
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="flex items-center gap-2 text-phx-sm font-bold uppercase tracking-[0.14em] text-phx-line-strong">
              <span>Low</span>
              <span
                aria-hidden="true"
                className="h-2.5 w-28 rounded-full transition-colors"
                style={{ background: legendGradient }}
              />
              <span>High</span>
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-3 p-5">
        <div
          className="flex items-center justify-center rounded-[14px] border border-[#DDE6F1] bg-phx-paper p-6 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.75)]"
          ref={mapRef}
          style={{ height }}
        >
          {!browserKey ? (
            <div>
              <p className="text-sm font-black text-phx-ink">Map unavailable</p>
              <p className="mt-2 max-w-xl text-sm leading-6 text-phx-ink-soft">
                NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY is missing from the environment.
              </p>
            </div>
          ) : error ? (
            <div>
              <p className="text-sm font-black text-phx-ink">Google Maps unavailable</p>
              <p className="mt-2 max-w-xl text-sm leading-6 text-phx-ink-soft">{error}</p>
            </div>
          ) : !ready ? (
            <p className="text-sm font-semibold text-phx-ink-soft">Loading Google Maps…</p>
          ) : !hasPoints ? (
            <p className="text-sm font-semibold text-phx-ink-soft">
              {mode === "approved"
                ? "No approved expenses on the map for these filters."
                : mode === "pending"
                  ? "No pending expenses on the map for these filters."
                  : "No mappable expenses for these filters."}
            </p>
          ) : null}
        </div>

        {unmappedCount > 0 ? (
          <AdminCallout tone="warning">
            <span>
              <strong>{unmappedCount.toLocaleString()}</strong> expense row{unmappedCount === 1 ? "" : "s"}
              {unmappedAmount > 0 ? ` (${egp(unmappedAmount)})` : ""} have no resolved location and aren&apos;t shown
              on the map. They remain in every KPI, chart, table, and the export. Mapped spend shown:{" "}
              {compactEgp(mappedSpend)} across {displayPoints.length} location{displayPoints.length === 1 ? "" : "s"}.
            </span>
          </AdminCallout>
        ) : null}
      </div>
    </div>
  );
}
