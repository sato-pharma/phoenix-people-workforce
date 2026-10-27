"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Card } from "@/components/ui/card";
import { TerritoryPreviewLinksPanel } from "@/components/territory-management/preview-links-panel";
import {
  importGoogleLibrary,
  loadGoogleMaps,
  type GoogleLatLngBoundsHandle,
  type GoogleMapHandle,
  type GoogleMapsApi,
  type GoogleMarkerHandle,
  type GooglePolylineHandle,
} from "@/lib/google-maps/browser";
import type {
  BrickSearchHit,
  ScopeOverviewLine,
  TerritoryArea,
  TerritoryFilters,
  TerritoryMap,
} from "@/lib/territory-management/service";
import {
  phxFieldClassName,
  phxSelectClassName,
} from "@/components/ui/form-tokens";

// One colour per selected area. Chosen to stay distinguishable against Google's roadmap tiles.
const AREA_COLOURS = [
  "#ef4444", "#3b82f6", "#22c55e", "#f59e0b", "#a855f7",
  "#ec4899", "#14b8a6", "#f97316", "#6366f1", "#84cc16",
];

// The Maps browser key is resolved server-side and passed down — getBrowserKey() lives in
// lib/google-maps/server.ts and must never be imported into a client component.
type Props = {
  browserKey: string | null;
  /** Pin editing is Super-Admin only — the server enforces it too, this just hides the affordance. */
  canEditPins: boolean;
  /** Publishing a passwordless preview link is Super-Admin only. Enforced server-side as well. */
  canPublishPreview: boolean;
  /**
   * Which shell this is rendered in, and therefore who owns the page title.
   *
   * `admin` — `app/(admin)/sales/territory-management/page.tsx` renders this workspace BARE, with no
   * shell around it, so the `<h1>` in the header below is the page's only title and must stay.
   *
   * `portal` — `app/employee-portals/territory-management/page.tsx` wraps it in
   * `EmployeePortalPageShell`, which already paints the navy command header carrying the title
   * `Territory Management` and the module sentence, so drawing the header here printed the same words
   * twice under two type scales (owner, 2026-09-30: "fix the duplicated header on territory
   * management too"). Same vocabulary as `KpisBoardView` and `FieldActivityView`, which solved this
   * before it.
   */
  chrome?: "admin" | "portal";
  filters: TerritoryFilters;
  initialError: string | null;
  /** Configured public origin, used to build a shareable link the recipient can actually open. */
  productionUrl: string;
};

/** How many findings show before the rest fold behind "Show the other N". */
const FINDINGS_SHOWN = 5;

/** A finding list that never drops an item: the first few open, every one of the rest one click away. */
function FindingList({ items }: { items: Array<{ key: string; text: string }> }) {
  const shown = items.slice(0, FINDINGS_SHOWN);
  const folded = items.slice(FINDINGS_SHOWN);
  return (
    <>
      <ul className="text-muted-foreground list-disc pl-5">
        {shown.map((item) => (
          <li key={item.key}>{item.text}</li>
        ))}
      </ul>
      {folded.length > 0 ? (
        <details className="text-muted-foreground mt-1">
          <summary className="cursor-pointer text-xs">Show the other {folded.length}</summary>
          <ul className="mt-1 list-disc pl-5">
            {folded.map((item) => (
              <li key={item.key}>{item.text}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}

type MapsNamespace = GoogleMapsApi & {
  Map: new (element: HTMLDivElement, options: Record<string, unknown>) => GoogleMapHandle;
  LatLngBounds: new () => GoogleLatLngBoundsHandle;
  Marker: new (options: Record<string, unknown>) => GoogleMarkerHandle;
  Polyline: new (options: Record<string, unknown>) => GooglePolylineHandle;
};

export function TerritoryMapWorkspace({
  browserKey,
  canEditPins,
  canPublishPreview,
  chrome = "admin",
  filters,
  initialError,
  productionUrl,
}: Props) {
  // ── in-map search + pin editing ───────────────────────────────────────────
  const [searchTerm, setSearchTerm] = useState("");
  const [searchHits, setSearchHits] = useState<BrickSearchHit[]>([]);
  const [editing, setEditing] = useState<BrickSearchHit | null>(null);
  const [draftPin, setDraftPin] = useState<{ lat: number; lng: number } | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const editMarker = useRef<GoogleMarkerHandle | null>(null);
  const [lineCode, setLineCode] = useState<string>(filters.lines[0]?.lineCode ?? "");
  const [lineFilters, setLineFilters] = useState<TerritoryFilters>(filters);
  const [regionCode, setRegionCode] = useState<string>("");
  const [selectedAreas, setSelectedAreas] = useState<string[]>([]);
  const [data, setData] = useState<TerritoryMap | null>(null);
  const [error, setError] = useState<string | null>(initialError);
  // Loading is DERIVED from "has the loaded selection caught up with the chosen one" rather than
  // set inside the effect. Avoids a synchronous setState in an effect and, more usefully, stops
  // the previous selection's map lingering while the next one loads.
  const [loadedKey, setLoadedKey] = useState("");
  const [fullscreen, setFullscreen] = useState(false);
  const [scopeOverview, setScopeOverview] = useState<ScopeOverviewLine[] | null>(null);
  const [scopeOpen, setScopeOpen] = useState(true);

  const mapRef = useRef<HTMLDivElement | null>(null);
  const mapInstance = useRef<GoogleMapHandle | null>(null);
  const overlays = useRef<{ markers: GoogleMarkerHandle[]; lines: GooglePolylineHandle[] }>({
    lines: [],
    markers: [],
  });
  const [maps, setMaps] = useState<MapsNamespace | null>(null);

  // ── scope overview: "this is your patch" the moment the module opens ────────
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/territory-management/scope")
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("Failed to load scope."))))
      .then((body: { lines: ScopeOverviewLine[] }) => {
        if (!cancelled) setScopeOverview(body.lines ?? []);
      })
      .catch(() => {
        if (!cancelled) setScopeOverview([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ── filters ───────────────────────────────────────────────────────────────
  // Selection resets live in the change handlers, not here — resetting state inside an effect
  // triggers an extra render pass (react-hooks/set-state-in-effect).
  useEffect(() => {
    if (!lineCode) return;
    let cancelled = false;
    void fetch(`/api/territory-management/filters?lineCode=${encodeURIComponent(lineCode)}`)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("Failed to load filters."))))
      .then((next: TerritoryFilters) => {
        if (!cancelled) setLineFilters(next);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      });
    return () => {
      cancelled = true;
    };
  }, [lineCode]);

  // Areas are constrained to one region at a time — comparing bricks across regions is not a
  // meaningful allocation question, and it makes the map unreadable.
  const areasInRegion = useMemo<TerritoryArea[]>(
    () => lineFilters.areas.filter((area) => !regionCode || area.regionCode === regionCode),
    [lineFilters.areas, regionCode],
  );

  const colourFor = useCallback(
    (areaCode: string) => AREA_COLOURS[Math.max(0, selectedAreas.indexOf(areaCode)) % AREA_COLOURS.length],
    [selectedAreas],
  );

  // ── map data ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!lineCode || selectedAreas.length === 0) return;
    let cancelled = false;
    const key = `${lineCode}|${selectedAreas.join(",")}`;
    const query = `lineCode=${encodeURIComponent(lineCode)}&areaCodes=${encodeURIComponent(selectedAreas.join(","))}`;
    void fetch(`/api/territory-management/map?${query}`)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("Failed to load territory map."))))
      .then((next: TerritoryMap) => {
        if (cancelled) return;
        setData(next);
        setError(null);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      })
      .finally(() => {
        if (!cancelled) setLoadedKey(key);
      });
    return () => {
      cancelled = true;
    };
  }, [lineCode, selectedAreas]);

  // ── brick search (debounced) ──────────────────────────────────────────────
  useEffect(() => {
    const term = searchTerm.trim();
    if (term.length < 2 || !lineCode) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      // The line travels with the query: a brick's region is a per-line fact, so the same brick
      // reads a different region on Anti Infective than on Pedia.
      void fetch(`/api/territory-management/search?q=${encodeURIComponent(term)}&lineCode=${encodeURIComponent(lineCode)}`)
        .then((response) => (response.ok ? response.json() : Promise.reject(new Error("Search failed."))))
        .then((body: { results: BrickSearchHit[] }) => {
          if (!cancelled) setSearchHits(body.results ?? []);
        })
        .catch(() => {
          if (!cancelled) setSearchHits([]);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [lineCode, searchTerm]);

  const beginEditing = (hit: BrickSearchHit) => {
    setEditing(hit);
    setSearchHits([]);
    setSearchTerm(hit.brickName);
    setSaveState("idle");
    setDraftPin(hit.lat != null && hit.lng != null ? { lat: hit.lat, lng: hit.lng } : null);
    const map = mapInstance.current;
    if (map && hit.lat != null && hit.lng != null) {
      map.setCenter?.({ lat: hit.lat, lng: hit.lng });
      map.setZoom?.(15);
    }
  };

  const savePin = async () => {
    if (!editing || !draftPin) return;
    setSaveState("saving");
    try {
      const response = await fetch("/api/territory-management/pin", {
        body: JSON.stringify({ brickId: editing.brickId, lat: draftPin.lat, lng: draftPin.lng }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Failed to save pin.");
      }
      setSaveState("saved");
      setError(null);
      // Re-pull the current selection so the moved brick redraws in place.
      setLoadedKey("");
    } catch (cause) {
      setSaveState("idle");
      setError(cause instanceof Error ? cause.message : "Failed to save pin.");
    }
  };

  // ── google maps bootstrap ─────────────────────────────────────────────────
  useEffect(() => {
    if (!browserKey || maps) return;
    let cancelled = false;
    void loadGoogleMaps(browserKey)
      .then(async (api) => {
        if (cancelled) return;
        const core = await importGoogleLibrary(api, "core", { LatLngBounds: api.LatLngBounds });
        const mapsLib = await importGoogleLibrary(api, "maps", { Map: api.Map, Polyline: api.Polyline });
        const markerLib = await importGoogleLibrary(api, "marker", { Marker: api.Marker });
        if (cancelled) return;
        setMaps({
          ...api,
          LatLngBounds: (core?.LatLngBounds ?? api.LatLngBounds) as MapsNamespace["LatLngBounds"],
          Map: (mapsLib?.Map ?? api.Map) as MapsNamespace["Map"],
          Marker: (markerLib?.Marker ?? api.Marker) as MapsNamespace["Marker"],
          Polyline: (mapsLib?.Polyline ?? api.Polyline) as MapsNamespace["Polyline"],
        });
      })
      .catch(() => setError("Google Maps failed to load — check the browser API key."));
    return () => {
      cancelled = true;
    };
  }, [browserKey, maps]);

  // ── draw ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!maps || !mapRef.current) return;
    if (!mapInstance.current) {
      mapInstance.current = new maps.Map(mapRef.current, {
        center: { lat: 26.8, lng: 30.8 }, // Egypt
        mapTypeControl: true,
        streetViewControl: false,
        zoom: 6,
      });
    }
    const map = mapInstance.current;

    for (const marker of overlays.current.markers) marker.setMap?.(null);
    for (const line of overlays.current.lines) line.setMap(null);
    overlays.current = { lines: [], markers: [] };
    if (!data) return;

    const bounds = new maps.LatLngBounds();

    for (const area of data.areas) {
      const colour = colourFor(area.areaCode);
      const byId = new Map(data.bricks.filter((b) => b.areaCode === area.areaCode).map((b) => [b.brickId, b]));

      // Shaded hull, drawn as a closed polyline (Polygon is not in the shared Maps surface).
      if (area.hull.length >= 3) {
        overlays.current.lines.push(
          new maps.Polyline({
            map,
            path: [...area.hull, area.hull[0]],
            strokeColor: colour,
            strokeOpacity: 0.55,
            strokeWeight: 2,
          }),
        );
      }

      // Minimum spanning tree — the real "cost to cover this area", not an N² spaghetti mesh.
      for (const edge of area.mstEdges) {
        const from = byId.get(edge.fromBrickId);
        const to = byId.get(edge.toBrickId);
        if (!from || !to) continue;
        overlays.current.lines.push(
          new maps.Polyline({
            map,
            path: [
              { lat: from.lat, lng: from.lng },
              { lat: to.lat, lng: to.lng },
            ],
            strokeColor: colour,
            strokeOpacity: 0.9,
            strokeWeight: 2.5,
          }),
        );
      }
    }

    for (const brick of data.bricks) {
      const colour = colourFor(brick.areaCode);
      const marker = new maps.Marker({
        icon: {
          fillColor: colour,
          fillOpacity: 0.95,
          path: maps.SymbolPath?.CIRCLE,
          scale: 6,
          strokeColor: "#ffffff",
          strokeWeight: 1.5,
        },
        map,
        position: { lat: brick.lat, lng: brick.lng },
        title: `${brick.brickName} · ${brick.areaName} · block ${brick.blockCode}\n${brick.confidence.percent}% — ${brick.confidence.label}`,
      });
      overlays.current.markers.push(marker);
      bounds.extend({ lat: brick.lat, lng: brick.lng });
    }

    if (data.bricks.length > 0) map.fitBounds(bounds, 48);
  }, [colourFor, data, maps]);

  // ── pin editing: click the map to place, marker shows the draft position ──
  useEffect(() => {
    const map = mapInstance.current;
    if (!maps || !map || !canEditPins) return;
    // GoogleMapHandle is a narrow shared type; the click listener is not on it.
    const clickable = map as unknown as {
      addListener?: (event: string, handler: (e: { latLng?: { lat(): number; lng(): number } }) => void) => { remove?: () => void };
    };
    const listener = clickable.addListener?.("click", (event) => {
      const lat = event.latLng?.lat();
      const lng = event.latLng?.lng();
      if (!editing || lat == null || lng == null) return;
      setDraftPin({ lat, lng });
      setSaveState("idle");
    });
    return () => listener?.remove?.();
  }, [canEditPins, editing, maps]);

  // The editable pin is DRAGGABLE — grab it and move it, exactly like dropping a pin in Google
  // Maps. Keyed on the brick only, never on draftPin: rebuilding the marker mid-gesture would
  // cancel the drag and the map would pan instead, which is what a fixed marker did before.
  useEffect(() => {
    if (!maps || !mapInstance.current) return;
    editMarker.current?.setMap?.(null);
    editMarker.current = null;
    if (!editing) return;

    const start =
      editing.lat != null && editing.lng != null
        ? { lat: editing.lat, lng: editing.lng }
        : { lat: 26.8, lng: 30.8 };

    const marker = new maps.Marker({
      cursor: "grab",
      draggable: canEditPins,
      icon: {
        fillColor: "#111827",
        fillOpacity: 1,
        path: maps.SymbolPath?.CIRCLE,
        scale: 10,
        strokeColor: "#ffffff",
        strokeWeight: 3,
      },
      map: mapInstance.current,
      position: start,
      title: `${editing.brickName} — drag me`,
      zIndex: 9999,
    });

    const draggable = marker as unknown as {
      addListener?: (event: string, handler: (e: { latLng?: { lat(): number; lng(): number } }) => void) => void;
    };
    draggable.addListener?.("dragend", (event) => {
      const lat = event.latLng?.lat();
      const lng = event.latLng?.lng();
      if (lat == null || lng == null) return;
      setDraftPin({ lat, lng });
      setSaveState("idle");
    });

    editMarker.current = marker;
    return () => marker.setMap?.(null);
  }, [canEditPins, editing, maps]);

  // A map tap moves the same marker, so tapping and dragging stay in sync.
  useEffect(() => {
    if (!draftPin || !editMarker.current) return;
    (editMarker.current as unknown as { setPosition?: (p: { lat: number; lng: number }) => void })
      .setPosition?.(draftPin);
  }, [draftPin]);

  const toggleArea = (areaCode: string) => {
    setSelectedAreas((current) =>
      current.includes(areaCode) ? current.filter((code) => code !== areaCode) : [...current, areaCode],
    );
  };

  const totalOrphans = data?.areas.reduce((sum, area) => sum + area.orphans.length, 0) ?? 0;
  const totalOverlaps = data?.areas.reduce((sum, area) => sum + area.overlaps.length, 0) ?? 0;

  return (
    <div className="space-y-4 p-4">
      {/* The title and the how-to-read-it sentence are the SHELL'S in the portal — see `chrome` in
          Props above. The admin route renders this workspace bare, so there the header IS the page. */}
      {chrome === "admin" ? (
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold">Territory Management</h1>
          <p className="text-muted-foreground text-sm">
            Pick a line, a region, then one or more areas. Bricks are plotted and linked along the shortest
            path that covers the area — so you can see whether allocation is tight or scattered.
          </p>
        </header>
      ) : null}

      {/* Own row rather than tucked into the header: collapsed it is one button, but open it is a
          full Card, and squeezing that into a header flex would shrink it to a column. */}
      {canPublishPreview ? <TerritoryPreviewLinksPanel productionUrl={productionUrl} /> : null}

      {error ? (
        <Card className="border-destructive/40 bg-destructive/5 p-3 text-sm">{error}</Card>
      ) : null}

      {/* Your scope, as a hierarchy, the moment the module opens — before picking anything. */}
      <Card className="p-4">
        <button
          className="flex w-full items-center justify-between text-left"
          onClick={() => setScopeOpen((current) => !current)}
          type="button"
        >
          <div>
            <h2 className="font-semibold">Your scope</h2>
            <p className="text-muted-foreground text-sm">
              Every line, region and area you can see here, and how many bricks each area carries.
            </p>
          </div>
          <span className="text-muted-foreground text-sm">{scopeOpen ? "Hide ▲" : "Show ▼"}</span>
        </button>

        {scopeOpen ? (
          scopeOverview == null ? (
            <p className="text-muted-foreground mt-3 text-sm">Loading your scope…</p>
          ) : scopeOverview.length === 0 ? (
            <p className="text-muted-foreground mt-3 text-sm">
              No sales territory is assigned to you yet — contact HR/your admin.
            </p>
          ) : (
            <div className="mt-3 space-y-3">
              {scopeOverview.map((line) => (
                <div key={line.lineCode}>
                  <p className="font-medium">{line.lineName}</p>
                  <ul className="mt-1 border-l pl-3">
                    {line.regions.map((region) => (
                      <li className="mt-2 border-l pl-3" key={region.regionCode}>
                        <p className="text-sm font-medium">{region.regionName}</p>
                        <ul className="mt-1 grid gap-x-4 gap-y-1 border-l pl-3 sm:grid-cols-2 lg:grid-cols-3">
                          {region.areas.map((area) => (
                            <li className="text-muted-foreground text-sm" key={area.areaCode}>
                              {area.areaName} <span className="text-xs">({area.brickCount} bricks)</span>
                            </li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )
        ) : null}
      </Card>

      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap gap-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Line</span>
            <select
              className={`${phxSelectClassName} min-w-44`}
              onChange={(event) => {
                setLineCode(event.target.value);
                setRegionCode("");
                setSelectedAreas([]);
                setData(null);
              }}
              value={lineCode}
            >
              {lineFilters.lines.map((line) => (
                <option key={line.lineCode} value={line.lineCode}>
                  {line.lineName}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Region</span>
            <select
              className={`${phxSelectClassName} min-w-44`}
              onChange={(event) => {
                setRegionCode(event.target.value);
                setSelectedAreas([]);
                setData(null);
              }}
              value={regionCode}
            >
              <option value="">Select a region…</option>
              {lineFilters.regions.map((region) => (
                <option key={region.regionCode} value={region.regionCode}>
                  {region.regionName} ({region.areaCount} areas)
                </option>
              ))}
            </select>
          </label>
        </div>

        {regionCode ? (
          <div className="space-y-2">
            <span className="text-sm font-medium">Areas — pick one or more (same region)</span>
            <div className="flex flex-wrap gap-2">
              {areasInRegion.map((area) => {
                const active = selectedAreas.includes(area.areaCode);
                return (
                  <button
                    className="rounded-full border px-3 py-1 text-sm transition"
                    key={area.areaCode}
                    onClick={() => toggleArea(area.areaCode)}
                    style={
                      active
                        ? { backgroundColor: colourFor(area.areaCode), borderColor: colourFor(area.areaCode), color: "#fff" }
                        : undefined
                    }
                    type="button"
                  >
                    {area.areaName}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </Card>

      {data ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Card className="p-3">
            <p className="text-muted-foreground text-xs uppercase">Bricks mapped</p>
            <p className="text-xl font-semibold">
              {data.coverage.located} <span className="text-muted-foreground text-sm">of {data.coverage.total}</span>
            </p>
          </Card>
          <Card className="p-3">
            <p className="text-muted-foreground text-xs uppercase">No location</p>
            <p className="text-xl font-semibold">
              {data.coverage.missing + data.coverage.sharedFallback + data.coverage.wrongRegion}
            </p>
          </Card>
          <Card className="p-3">
            <p className="text-muted-foreground text-xs uppercase">Far-out bricks</p>
            <p className="text-xl font-semibold">{totalOrphans}</p>
          </Card>
          <Card className="p-3">
            <p className="text-muted-foreground text-xs uppercase">Closer to another area</p>
            <p className="text-xl font-semibold">{totalOverlaps}</p>
          </Card>
        </div>
      ) : null}

      <Card className="overflow-hidden p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-medium">
            {selectedAreas.length > 0 && loadedKey !== `${lineCode}|${selectedAreas.join(",")}`
              ? "Loading territory…"
              : "Map"}
          </span>
          <button
            className="rounded-md border px-3 py-1 text-sm"
            onClick={() => setFullscreen((current) => !current)}
            type="button"
          >
            {fullscreen ? "Exit full screen" : "Full screen"}
          </button>
        </div>
        {browserKey ? (
          <div className={fullscreen ? "fixed inset-0 z-50" : "relative"}>
            {/* Search sits ON the map, like the mobile Google Maps box. */}
            <div className="absolute top-3 left-1/2 z-30 w-[min(92%,30rem)] -translate-x-1/2 space-y-2">
              <input
                aria-label="Search bricks"
                className={phxFieldClassName}
                onChange={(event) => {
                  setSearchTerm(event.target.value);
                  setSaveState("idle");
                }}
                placeholder="Search a brick by name…"
                value={searchTerm}
              />

              {searchHits.length > 0 ? (
                <ul className="bg-background max-h-72 overflow-auto rounded-xl border shadow-lg">
                  {searchHits.map((hit) => (
                    <li key={hit.brickId}>
                      <button
                        className="hover:bg-muted flex w-full flex-col items-start gap-0.5 px-4 py-2 text-left text-sm"
                        onClick={() => beginEditing(hit)}
                        type="button"
                      >
                        <span className="font-medium">{hit.brickName}</span>
                        <span className="text-muted-foreground text-xs">
                          {hit.areaName} · {hit.regionName} · block {hit.blockCode}
                          {hit.lat == null ? " · no pin yet" : ""}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}

              {editing ? (
                <div className="bg-background space-y-2 rounded-xl border p-3 shadow-lg">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-medium">{editing.brickName}</p>
                      <p className="text-muted-foreground text-xs">
                        {editing.areaName} · block {editing.blockCode}
                      </p>
                    </div>
                    <button
                      className="text-muted-foreground text-xs underline"
                      onClick={() => {
                        setEditing(null);
                        setDraftPin(null);
                        setSearchTerm("");
                        setSaveState("idle");
                      }}
                      type="button"
                    >
                      Close
                    </button>
                  </div>

                  {saveState === "saved" ? (
                    <p className="text-sm font-medium text-green-600">
                      ✓ Confirmed — this is now the brick&apos;s actual location (100%). It will not be
                      overwritten by geocoding.
                    </p>
                  ) : canEditPins ? (
                    <>
                      <p className="text-muted-foreground text-xs">
                        Drag the black pin to the right spot, or tap the map to jump it there
                        {draftPin ? ` — ${draftPin.lat.toFixed(5)}, ${draftPin.lng.toFixed(5)}` : "."}
                      </p>
                      <button
                        className="bg-primary text-primary-foreground w-full rounded-md px-3 py-2 text-sm disabled:opacity-50"
                        disabled={!draftPin || saveState === "saving"}
                        onClick={() => void savePin()}
                        type="button"
                      >
                        {saveState === "saving" ? "Saving…" : "Confirm this location"}
                      </button>
                    </>
                  ) : (
                    <p className="text-muted-foreground text-xs">
                      Only a Super Admin can move a brick pin.
                    </p>
                  )}
                </div>
              ) : null}
            </div>

            <div className={fullscreen ? "h-full w-full" : "h-[560px] w-full"} ref={mapRef} />
          </div>
        ) : (
          <p className="p-4 text-sm">Google Maps browser key is not configured.</p>
        )}
        {fullscreen ? (
          <button
            className="bg-background fixed top-4 right-4 z-[60] rounded-md border px-3 py-1 text-sm shadow"
            onClick={() => setFullscreen(false)}
            type="button"
          >
            Exit full screen
          </button>
        ) : null}
      </Card>

      {data?.areas.map((area) => (
        <Card className="space-y-2 p-4" key={area.areaCode}>
          <div className="flex items-center gap-2">
            <span className="inline-block size-3 rounded-full" style={{ backgroundColor: colourFor(area.areaCode) }} />
            <h2 className="font-semibold">{area.areaName}</h2>
            <span className="text-muted-foreground text-sm">
              {area.locatedCount} of {area.totalCount} bricks mapped
            </span>
          </div>
          <div className="text-muted-foreground grid gap-2 text-sm sm:grid-cols-3">
            <span>Route to cover: <strong>{area.mstKm ?? "—"} km</strong></span>
            <span>Widest span: <strong>{area.spreadKm ?? "—"} km</strong></span>
            <span>Average gap: <strong>{area.meanPairKm ?? "—"} km</strong></span>
          </div>

          {/* Every finding is listed: the first five open, the rest one click away. Cutting the list
              at five silently dropped the rest, and a dropped brick reads as a clean one. */}
          {area.overlaps.length > 0 ? (
            <div className="text-sm">
              <p className="font-medium">
                Closer to another area — likely mis-assigned ({area.overlaps.length})
              </p>
              <FindingList
                items={area.overlaps.map((overlap) => ({
                  key: overlap.brickId,
                  text: `${overlap.brickName} — ${overlap.kmToOwnCentre} km from ${area.areaName}, but ${overlap.kmToOtherCentre} km from ${overlap.nearerAreaName}`,
                }))}
              />
            </div>
          ) : null}

          {area.orphans.length > 0 ? (
            <div className="text-sm">
              <p className="font-medium">
                Far from the rest of the area ({area.orphans.length})
                {area.medianKmFromCentre != null ? (
                  <span className="text-muted-foreground font-normal">
                    {" "}— half the area sits within {area.medianKmFromCentre} km of its centre
                  </span>
                ) : null}
              </p>
              <FindingList
                items={area.orphans.map((orphan) => ({
                  key: orphan.brickId,
                  text: `${orphan.brickName} — ${orphan.kmFromCentre} km from the area centre`,
                }))}
              />
            </div>
          ) : null}

          {(() => {
            const rec = data?.residence.find((r) => r.areaCode === area.areaCode);
            if (!rec) return null;
            const [best, ...runnersUp] = rec.options;
            return (
              <div className="border-t pt-2 text-sm">
                <p className="font-medium">Best residence for a Medical Rep hired here: {best.brickName}</p>
                <ul className="text-muted-foreground list-disc pl-5">
                  {best.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
                {runnersUp.length > 0 ? (
                  <details className="text-muted-foreground mt-1">
                    <summary className="cursor-pointer text-xs">Runner-up options</summary>
                    <ul className="mt-1 list-disc pl-5">
                      {runnersUp.map((option) => (
                        <li key={option.brickId}>
                          <span className="font-medium">{option.brickName}</span>:{" "}
                          {option.reasons.join(" ")}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
                {rec.warning ? <p className="text-xs italic">{rec.warning}</p> : null}
              </div>
            );
          })()}
        </Card>
      ))}

      {data && data.unlocated.length > 0 ? (
        <Card className="space-y-2 p-4">
          <h2 className="font-semibold">Bricks with no location ({data.unlocated.length})</h2>
          <p className="text-muted-foreground text-sm">
            These are listed rather than hidden. On a map an unplotted brick looks identical to one nobody
            covers, which would invent gaps that are not real.
          </p>
          <ul className="text-muted-foreground grid gap-1 text-sm sm:grid-cols-2">
            {data.unlocated.map((brick) => (
              <li key={brick.brickId}>
                {brick.brickName} — {brick.areaName}{" "}
                <span className="text-xs">
                  (
                  {brick.reason === "shared-fallback"
                    ? "geocoder returned a shared city-centre pin"
                    : brick.reason === "wrong-region"
                      ? "geocoded into the wrong governorate"
                      : "never geocoded"}
                  )
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
