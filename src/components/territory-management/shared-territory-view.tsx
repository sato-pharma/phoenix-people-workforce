"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  importGoogleLibrary,
  loadGoogleMaps,
  type GoogleLatLngBoundsHandle,
  type GoogleMapHandle,
  type GoogleMapsApi,
  type GoogleMarkerHandle,
} from "@/lib/google-maps/browser";
import type {
  PreviewArea,
  PreviewAreaBricks,
  PreviewRegion,
} from "@/lib/territory-management/preview-links";
import {
  phxLabelClassName,
  phxSelectClassName,
} from "@/components/ui/form-tokens";

type Props = { browserKey: string | null; token: string };

type MapsNamespace = GoogleMapsApi & {
  LatLngBounds: new () => GoogleLatLngBoundsHandle;
  Map: new (element: HTMLDivElement, options: Record<string, unknown>) => GoogleMapHandle;
  Marker: new (options: Record<string, unknown>) => GoogleMarkerHandle;
};

const PIN_COLOUR = "#f97316";

/**
 * The recipient's view of a shared territory (owner request, 2026-08-14).
 *
 * Region, then area, then pins — the flow the owner described, and nothing else. There is no line
 * selector and no line NAME anywhere on this page: the link is pinned to one server-side, and the
 * viewer is deliberately not told which.
 *
 * Holds nothing until the server accepts the token, so viewing the page source reveals no
 * geography. Every open re-queries, which is what makes the link current rather than a snapshot
 * someone has to remember to resend.
 */
export function SharedTerritoryView({ browserKey, token }: Props) {
  const [regions, setRegions] = useState<PreviewRegion[] | null>(null);
  const [areas, setAreas] = useState<PreviewArea[]>([]);
  const [label, setLabel] = useState<string | null>(null);
  const [regionCode, setRegionCode] = useState("");
  const [areaCode, setAreaCode] = useState("");
  const [area, setArea] = useState<PreviewAreaBricks | null>(null);
  const [loadingArea, setLoadingArea] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mapRef = useRef<HTMLDivElement | null>(null);
  const mapInstance = useRef<GoogleMapHandle | null>(null);
  const markers = useRef<GoogleMarkerHandle[]>([]);
  const [maps, setMaps] = useState<MapsNamespace | null>(null);

  // ── what this link may show ───────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/share/territory/${encodeURIComponent(token)}/filters`)
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as {
          success?: boolean;
          message?: string;
          regions?: PreviewRegion[];
          areas?: PreviewArea[];
          label?: string | null;
        };
        if (!response.ok || !body.success) throw new Error(body.message || "This link is not available.");
        return body;
      })
      .then((body) => {
        if (cancelled) return;
        setRegions(body.regions ?? []);
        setAreas(body.areas ?? []);
        setLabel(body.label ?? null);
      })
      .catch((cause: Error) => {
        if (!cancelled) {
          setRegions([]);
          setError(cause.message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  // ── the chosen area's bricks ──────────────────────────────────────────────
  useEffect(() => {
    if (!areaCode) return;
    let cancelled = false;
    void fetch(`/api/share/territory/${encodeURIComponent(token)}/map?areaCode=${encodeURIComponent(areaCode)}`)
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as PreviewAreaBricks & {
          success?: boolean;
          message?: string;
        };
        if (!response.ok || !body.success) throw new Error(body.message || "Could not load that area.");
        return body;
      })
      .then((body) => {
        if (cancelled) return;
        setArea(body);
        setError(null);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      })
      .finally(() => {
        if (!cancelled) setLoadingArea(false);
      });
    return () => {
      cancelled = true;
    };
  }, [areaCode, token]);

  // ── google maps bootstrap ─────────────────────────────────────────────────
  useEffect(() => {
    if (!browserKey || maps) return;
    let cancelled = false;
    void loadGoogleMaps(browserKey)
      .then(async (api) => {
        if (cancelled) return;
        const core = await importGoogleLibrary(api, "core", { LatLngBounds: api.LatLngBounds });
        const mapsLib = await importGoogleLibrary(api, "maps", { Map: api.Map });
        const markerLib = await importGoogleLibrary(api, "marker", { Marker: api.Marker });
        if (cancelled) return;
        setMaps({
          ...api,
          LatLngBounds: (core?.LatLngBounds ?? api.LatLngBounds) as MapsNamespace["LatLngBounds"],
          Map: (mapsLib?.Map ?? api.Map) as MapsNamespace["Map"],
          Marker: (markerLib?.Marker ?? api.Marker) as MapsNamespace["Marker"],
        });
      })
      .catch(() => setError("The map could not be loaded. Please try again later."));
    return () => {
      cancelled = true;
    };
  }, [browserKey, maps]);

  // ── draw the pins ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!maps || !mapRef.current) return;
    if (!mapInstance.current) {
      mapInstance.current = new maps.Map(mapRef.current, {
        center: { lat: 26.8, lng: 30.8 }, // Egypt
        mapTypeControl: false,
        streetViewControl: false,
        zoom: 6,
      });
    }
    const map = mapInstance.current;

    for (const marker of markers.current) marker.setMap?.(null);
    markers.current = [];
    if (!area || area.bricks.length === 0) return;

    const bounds = new maps.LatLngBounds();
    for (const brick of area.bricks) {
      markers.current.push(
        new maps.Marker({
          icon: {
            fillColor: PIN_COLOUR,
            fillOpacity: 0.95,
            path: maps.SymbolPath?.CIRCLE,
            scale: 7,
            strokeColor: "#ffffff",
            strokeWeight: 1.5,
          },
          map,
          position: { lat: brick.lat, lng: brick.lng },
          title: `${brick.brickName} · block ${brick.blockCode}`,
        }),
      );
      bounds.extend({ lat: brick.lat, lng: brick.lng });
    }
    map.fitBounds(bounds, 48);
  }, [area, maps]);

  const selectClass =
    `${phxSelectClassName} mt-1`;
  const labelClass = phxLabelClassName;

  const chooseRegion = useCallback((next: string) => {
    setRegionCode(next);
    setAreaCode("");
    setArea(null);
    setError(null);
  }, []);

  const chooseArea = useCallback((next: string) => {
    setAreaCode(next);
    setArea(null);
    setError(null);
    setLoadingArea(Boolean(next));
  }, []);

  // A dead link gets the whole page, not a banner over a form that cannot work.
  if (regions !== null && regions.length === 0 && error) {
    return (
      <section className="mx-auto max-w-md border border-phx-line bg-white">
        <header className="border-b border-phx-line bg-slate-900 px-4 py-3">
          <p className="text-phx-xs font-black tracking-[0.14em] text-orange-400 uppercase">Phoenix</p>
          <h1 className="text-base font-black text-white">Territory Preview</h1>
        </header>
        <p className="px-4 py-5 text-phx-md font-semibold text-rose-600">{error}</p>
      </section>
    );
  }

  const areasInRegion = areas.filter((entry) => entry.regionCode === regionCode);

  return (
    <section className="border border-phx-line bg-white">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-phx-line bg-slate-900 px-4 py-3">
        <div>
          <p className="text-phx-xs font-black tracking-[0.14em] text-orange-400 uppercase">Phoenix</p>
          <h1 className="text-base font-black text-white">{label ?? "Territory Preview"}</h1>
        </div>
        {area ? (
          <p className="min-w-0 break-words text-phx-sm font-bold text-slate-300">
            {area.areaName} — {area.bricks.length} bricks on the map
          </p>
        ) : null}
      </header>

      <div className="space-y-4 px-4 py-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className={labelClass} htmlFor="territory-preview-region">
              Region
            </label>
            <select
              className={selectClass}
              id="territory-preview-region"
              onChange={(event) => chooseRegion(event.target.value)}
              value={regionCode}
            >
              <option value="">
                {regions === null ? "Loading…" : "Select a region…"}
              </option>
              {(regions ?? []).map((region) => (
                <option key={region.regionCode} value={region.regionCode}>
                  {region.regionName} ({region.areaCount} areas)
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className={labelClass} htmlFor="territory-preview-area">
              Area
            </label>
            <select
              className={selectClass}
              disabled={!regionCode}
              id="territory-preview-area"
              onChange={(event) => chooseArea(event.target.value)}
              value={areaCode}
            >
              <option value="">{regionCode ? "Select an area…" : "Pick a region first"}</option>
              {areasInRegion.map((entry) => (
                <option key={entry.areaCode} value={entry.areaCode}>
                  {entry.areaName}
                </option>
              ))}
            </select>
          </div>
        </div>

        {error ? <p className="text-phx-md font-semibold text-rose-600">{error}</p> : null}

        <div className="border border-phx-line">
          {browserKey ? (
            <div className="h-[420px] w-full sm:h-[520px]" ref={mapRef} />
          ) : (
            <p className="px-4 py-6 text-phx-md text-slate-600">The map is not available right now.</p>
          )}
        </div>

        {loadingArea ? (
          <p className="text-phx-md text-slate-600">Loading the bricks…</p>
        ) : !areaCode ? (
          <p className="text-phx-md text-slate-600">
            Choose a region and then an area to see its bricks on the map.
          </p>
        ) : null}

        {area ? (
          <div className="space-y-3">
            <div>
              <h2 className="text-phx-xs font-black tracking-wider text-slate-500 uppercase">
                Bricks in {area.areaName}
              </h2>
              <ul className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
                {area.bricks.map((brick) => (
                  <li className="min-w-0 break-words text-phx-md text-slate-700" key={brick.brickId}>
                    {brick.brickName}
                  </li>
                ))}
              </ul>
            </div>

            {/* Listed, never dropped: on a map an unplotted brick is indistinguishable from one
                nobody covers, which would invent gaps that are not real and hide ones that are. */}
            {area.unlocated.length > 0 ? (
              <div className="border-t border-[#eef1f3] pt-3">
                <h2 className="text-phx-xs font-black tracking-wider text-slate-500 uppercase">
                  Also in this area, not yet placed on the map ({area.unlocated.length})
                </h2>
                <ul className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
                  {area.unlocated.map((brick) => (
                    <li className="min-w-0 break-words text-phx-md text-slate-500" key={brick.brickId}>
                      {brick.brickName}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
