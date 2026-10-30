"use client";

/**
 * Phoenix CRM — My map's Google map: one square pin per validated place, grouped into count tiles at a wide zoom.
 *
 * 🔴 ONE MAP FOR THE ELEMENT'S LIFE. A filter, a pick or a pan redraws the markers on the map that is already
 * there; a new map each time reloaded every tile and threw away the reader's own pan and zoom. The view is fitted
 * again only when WHAT is shown changes (`fitKey`), never for a pick or a colour.
 *
 * 🔴 ONLY WHAT THE MAP SHOWS IS DRAWN. A national manager's map holds thousands of pins; every time the map comes
 * to rest the markers are redrawn for the part of it on screen, grouped below `MY_MAP_GROUP_BELOW_ZOOM` into one
 * numbered square per screen cell (`groupPins`, where every pin is in exactly one group). A tap on a group zooms
 * in on it.
 *
 * 🔴 A GROUP WEARS ITS PINS' OWN COLOUR (owner, 2026-10-31: "validated doctors near each other are colored the
 * same color as the reps list"). Pins of different colours are never grouped together, so an AM tile is amber, a
 * PM tile indigo and a pharmacy tile teal — or, coloured by visits, the tier its places share.
 *
 * 🔴 "WHERE AM I" IS DRAWN, NEVER SENT. The browser's own reading of where the phone is becomes one square on this
 * map and nothing else: it is not posted, not stored, and no distance to any pin is ever worked out from it.
 *
 * 🔴 A MARKER THAT DID NOT CHANGE IS KEPT. Each redraw keys every marker by what it looks like; one whose key is
 * still wanted stays on the map untouched, so panning a national map no longer tears down and rebuilds every
 * pin, and only the ones that came on screen, went off it or changed are touched.
 *
 * The browser key comes from the page (`getBrowserKey()`, read on the server for each request), the same way
 * Territory Management gets it, so the map does not depend on the key having been baked into the build.
 *
 * Square markers throughout: the square-edge rule applies to a map pin as much as to a card.
 */

import { LoaderCircle, LocateFixed, Maximize2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { countText } from "@/components/phoenix-crm/format";
import { CrmButton, CrmNote } from "@/components/phoenix-crm/ui";
import {
  importGoogleLibrary,
  loadGoogleMaps,
  type GoogleMapHandle,
  type GoogleMapsApi,
  type GoogleMarkerHandle,
} from "@/lib/google-maps/browser";
import { groupPins, insideBounds, type GeoBounds } from "@/lib/phoenix-crm/my-map-geometry";

const SQUARE = "M -9 -9 L 9 -9 L 9 9 L -9 9 z";
const PICKED_STROKE = "#ea580c";
const NEW_STROKE = "#0f172a";
const ME_FILL = "#2563eb";

/** One pin as the screen wants it drawn. */
export type DrawnPin = {
  id: string;
  lat: number;
  lon: number;
  fill: string;
  /** Drawn as an outline only: not visited this month, in "Colour by this month's visits". */
  hollow: boolean;
  isNew: boolean;
  planned: boolean;
  title: string;
};

export type MapView = { bounds: GeoBounds; zoom: number };

/** The handful of the live map's own calls this canvas uses beyond the shared handle. */
type LiveMap = GoogleMapHandle & {
  getZoom?(): number | undefined;
  getBounds?(): { getNorthEast(): { lat(): number; lng(): number }; getSouthWest(): { lat(): number; lng(): number } } | null | undefined;
  addListener?(eventName: string, handler: () => void): unknown;
};

type Ctors = { Marker: NonNullable<GoogleMapsApi["Marker"]>; Bounds: GoogleMapsApi["LatLngBounds"] };

/** The view that holds every pin shown: one pin is centred close up, more are fitted with a margin. */
function fitTo(map: LiveMap, ctors: Ctors, pins: ReadonlyArray<DrawnPin>) {
  if (pins.length === 0) return;
  if (pins.length === 1 || !ctors.Bounds) {
    map.setCenter?.({ lat: pins[0].lat, lng: pins[0].lon });
    map.setZoom?.(15);
    return;
  }
  const bounds = new ctors.Bounds();
  for (const pin of pins) bounds.extend({ lat: pin.lat, lng: pin.lon });
  map.fitBounds(bounds, 48);
}

function squareIcon({ fill, fillOpacity = 1, scale = 1, stroke, strokeWeight }: { fill: string; fillOpacity?: number; scale?: number; stroke: string; strokeWeight: number }) {
  return { fillColor: fill, fillOpacity, path: SQUARE, scale, strokeColor: stroke, strokeWeight };
}

function pinIcon(pin: DrawnPin, picked: boolean) {
  const stroke = picked ? PICKED_STROKE : pin.isNew ? NEW_STROKE : pin.hollow ? pin.fill : "#ffffff";
  return squareIcon({
    fill: pin.hollow ? "#ffffff" : pin.fill,
    scale: pin.planned ? 0.95 : 0.7,
    stroke,
    strokeWeight: picked || pin.isNew ? 3 : pin.hollow ? 2.5 : 1.5,
  });
}

function groupScale(count: number): number {
  if (count < 10) return 1.15;
  if (count < 100) return 1.4;
  if (count < 1000) return 1.7;
  return 2;
}

/** The live map's bounds and zoom, or null while it has none yet. */
function readView(map: LiveMap): MapView | null {
  const bounds = map.getBounds?.();
  const zoom = map.getZoom?.();
  if (!bounds || typeof zoom !== "number") return null;
  const north = bounds.getNorthEast().lat();
  const east = bounds.getNorthEast().lng();
  const south = bounds.getSouthWest().lat();
  const west = bounds.getSouthWest().lng();
  return { bounds: { north, south, east, west }, zoom };
}

/** A quarter of the screen beyond each edge, so a pin at the edge does not blink in and out while panning. */
function padded(bounds: GeoBounds): GeoBounds {
  const lat = (bounds.north - bounds.south) / 4;
  const lon = (bounds.east - bounds.west) / 4;
  return { north: bounds.north + lat, south: bounds.south - lat, east: bounds.east + lon, west: bounds.west - lon };
}

/** What a single pin looks like; a marker is kept across redraws while this stays the same. */
function pinKey(pin: DrawnPin, picked: boolean): string {
  return ["pin", pin.id, pin.fill, pin.hollow, pin.isNew, pin.planned, picked, pin.title].join("|");
}

export function MyMapCanvas({
  browserKey,
  fitKey,
  focus,
  onPick,
  onView,
  pickedId,
  pins,
}: {
  /** The Google Maps browser key, read on the server by the page. */
  browserKey: string;
  /** What is shown; the view is fitted again only when this changes. */
  fitKey: string;
  /** A pin to bring into view and zoom to — a search result or a row of the list. */
  focus: { id: string; lat: number; lon: number; nonce: number } | null;
  onPick: (pinId: string | null) => void;
  onView: (view: MapView) => void;
  pickedId: string | null;
  pins: ReadonlyArray<DrawnPin>;
}) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<{ element: HTMLDivElement; map: LiveMap } | null>(null);
  const ctorRef = useRef<Ctors | null>(null);
  const markersRef = useRef<Map<string, GoogleMarkerHandle>>(new Map());
  const meMarkerRef = useRef<GoogleMarkerHandle | null>(null);
  const fittedKeyRef = useRef<string | null>(null);
  const focusedRef = useRef<number | null>(null);
  const pickRef = useRef(onPick);
  const viewRef = useRef(onView);
  const [googleMaps, setGoogleMaps] = useState<GoogleMapsApi | null>(null);
  const [ready, setReady] = useState(false);
  const [view, setView] = useState<MapView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [me, setMe] = useState<"idle" | "finding" | "shown" | "refused">("idle");

  useEffect(() => {
    pickRef.current = onPick;
    viewRef.current = onView;
  }, [onPick, onView]);

  useEffect(() => {
    if (!browserKey) return;
    let cancelled = false;
    void loadGoogleMaps(browserKey)
      .then((maps) => {
        if (!cancelled) setGoogleMaps(maps);
      })
      .catch(() => {
        if (!cancelled) setError("Google Maps could not load. The list below still holds every customer.");
      });
    return () => {
      cancelled = true;
    };
  }, [browserKey]);

  // The map itself, once.
  useEffect(() => {
    const element = elementRef.current;
    if (!googleMaps || !element || mapRef.current?.element === element) return;
    let cancelled = false;
    void (async () => {
      try {
        const core = await importGoogleLibrary(googleMaps, "core", { LatLngBounds: googleMaps.LatLngBounds });
        const maps = await importGoogleLibrary(googleMaps, "maps", { Map: googleMaps.Map });
        const marker = await importGoogleLibrary(googleMaps, "marker", { Marker: googleMaps.Marker });
        if (cancelled) return;
        const MapCtor = (maps?.Map as GoogleMapsApi["Map"]) ?? googleMaps.Map;
        const MarkerCtor = (marker?.Marker as GoogleMapsApi["Marker"]) ?? googleMaps.Marker;
        const BoundsCtor = (core?.LatLngBounds as GoogleMapsApi["LatLngBounds"]) ?? googleMaps.LatLngBounds;
        if (!MapCtor || !MarkerCtor) {
          setError("Google Maps loaded, but the map could not be drawn. Refresh and try again.");
          return;
        }
        const map = new MapCtor(element, {
          center: { lat: 30.0444, lng: 31.2357 },
          clickableIcons: false,
          fullscreenControl: true,
          mapTypeControl: false,
          streetViewControl: false,
          zoom: 11,
        }) as LiveMap;
        mapRef.current = { element, map };
        ctorRef.current = { Marker: MarkerCtor, Bounds: BoundsCtor };
        map.addListener?.("idle", () => {
          const next = readView(map);
          if (!next) return;
          setView(next);
          viewRef.current(next);
        });
        map.addListener?.("click", () => pickRef.current(null));
        setReady(true);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Google Maps could not draw the map.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [googleMaps]);

  // Fit the view to what is shown — only when what is shown changes.
  useEffect(() => {
    const live = mapRef.current;
    const ctors = ctorRef.current;
    if (!ready || !live || !ctors || pins.length === 0 || fittedKeyRef.current === fitKey) return;
    fittedKeyRef.current = fitKey;
    fitTo(live.map, ctors, pins);
  }, [fitKey, pins, ready]);

  // Bring one pin into view.
  useEffect(() => {
    const live = mapRef.current;
    if (!ready || !live || !focus || focusedRef.current === focus.nonce) return;
    focusedRef.current = focus.nonce;
    live.map.setCenter?.({ lat: focus.lat, lng: focus.lon });
    live.map.setZoom?.(16);
  }, [focus, ready]);

  // The markers, for the part of the map on screen.
  useEffect(() => {
    const live = mapRef.current;
    const ctors = ctorRef.current;
    if (!ready || !live || !ctors || !view) return;
    const previous = markersRef.current;
    const next = new Map<string, GoogleMarkerHandle>();
    // Two markers that would look exactly alike still get a marker each.
    const claim = (key: string) => {
      let unique = key;
      while (next.has(unique)) unique += "+";
      return unique;
    };
    const keep = (key: string) => {
      const kept = previous.get(key);
      if (!kept) return false;
      previous.delete(key);
      next.set(key, kept);
      return true;
    };
    const area = padded(view.bounds);
    const onScreen = pins.filter((pin) => insideBounds(pin, area));
    for (const group of groupPins(onScreen, view.zoom, (pin) => pin.fill)) {
      if (group.members.length === 1) {
        const pin = group.members[0];
        const picked = pin.id === pickedId;
        const key = claim(pinKey(pin, picked));
        if (keep(key)) continue;
        const handle = new ctors.Marker({
          icon: pinIcon(pin, picked),
          label: pin.planned ? { color: pin.hollow ? pin.fill : "#ffffff", fontSize: "11px", fontWeight: "900", text: "✓" } : undefined,
          map: live.map,
          position: { lat: pin.lat, lng: pin.lon },
          title: pin.title,
          zIndex: picked ? 3000 : pin.planned ? 2000 : pin.isNew ? 1500 : 1000,
        });
        handle.addListener?.("click", () => pickRef.current(pin.id));
        next.set(key, handle);
        continue;
      }
      const count = group.members.length;
      const fill = group.members[0].fill;
      const key = claim(["group", fill, group.lat.toFixed(5), group.lon.toFixed(5), count].join("|"));
      if (keep(key)) continue;
      const handle = new ctors.Marker({
        icon: squareIcon({ fill, scale: groupScale(count), stroke: "#ffffff", strokeWeight: 2 }),
        label: { color: "#ffffff", fontSize: "11px", fontWeight: "900", text: countText(count) },
        map: live.map,
        position: { lat: group.lat, lng: group.lon },
        title: `${countText(count)} places here — tap to zoom in`,
        zIndex: 500,
      });
      // A kept group outlives the view it was drawn in, so the zoom is read when it is tapped.
      handle.addListener?.("click", () => {
        live.map.setCenter?.({ lat: group.lat, lng: group.lon });
        live.map.setZoom?.(Math.min((live.map.getZoom?.() ?? view.zoom) + 2, 18));
      });
      next.set(key, handle);
    }
    previous.forEach((handle) => handle.setMap?.(null));
    markersRef.current = next;
  }, [pickedId, pins, ready, view]);

  useEffect(
    () => () => {
      markersRef.current.forEach((handle) => handle.setMap?.(null));
      meMarkerRef.current?.setMap?.(null);
    },
    [],
  );

  const showMe = () => {
    const live = mapRef.current;
    const ctors = ctorRef.current;
    if (!live || !ctors || typeof navigator === "undefined" || !navigator.geolocation) {
      setMe("refused");
      return;
    }
    setMe("finding");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const spot = { lat: position.coords.latitude, lng: position.coords.longitude };
        meMarkerRef.current?.setMap?.(null);
        meMarkerRef.current = new ctors.Marker({
          icon: squareIcon({ fill: ME_FILL, scale: 0.6, stroke: "#ffffff", strokeWeight: 3 }),
          map: live.map,
          position: spot,
          title: "You are here",
          zIndex: 4000,
        });
        live.map.setCenter?.(spot);
        live.map.setZoom?.(15);
        setMe("shown");
      },
      () => setMe("refused"),
      { enableHighAccuracy: true, maximumAge: 60_000, timeout: 15_000 },
    );
  };

  if (!browserKey) {
    return (
      <CrmNote tone="warn" title="The map is unavailable">
        The Google Maps browser key is missing from this environment. The list below still holds every customer.
      </CrmNote>
    );
  }

  const showAll = () => {
    const live = mapRef.current;
    const ctors = ctorRef.current;
    if (live && ctors) fitTo(live.map, ctors, pins);
  };

  return (
    <div className="min-w-0">
      <div className="relative min-w-0">
        <div className="h-[420px] min-w-0 border border-slate-200 bg-slate-100 sm:h-[560px]" ref={elementRef} />
        {ready ? (
          // Along the top, clear of Google's full-screen button on the right and its logo and terms along the bottom.
          <div className="pointer-events-none absolute left-3 right-14 top-3 flex flex-wrap gap-2">
            <CrmButton busy={me === "finding"} className="pointer-events-auto border-slate-300" onClick={showMe} size="sm">
              {me === "finding" ? null : <LocateFixed aria-hidden className="h-4 w-4" />}
              Where I am
            </CrmButton>
            {pins.length > 0 ? (
              <CrmButton className="pointer-events-auto border-slate-300" onClick={showAll} size="sm">
                <Maximize2 aria-hidden className="h-4 w-4" />
                All pins
              </CrmButton>
            ) : null}
          </div>
        ) : null}
        {!ready && !error ? (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm font-bold text-slate-500" role="status">
            <LoaderCircle aria-hidden className="h-5 w-5 animate-spin" />
            Loading the map
          </div>
        ) : null}
        {error ? (
          <div className="absolute inset-0 flex items-center justify-center p-4">
            <CrmNote className="max-w-md" tone="warn" title="The map did not load">
              {error}
            </CrmNote>
          </div>
        ) : null}
      </div>
      {me === "refused" ? (
        <p className="mt-2 break-words text-xs font-semibold leading-5 text-slate-500">
          This phone did not share where it is, so the map stays where it was. Allow location for this site in the browser to see yourself on it.
        </p>
      ) : null}
      {me === "shown" ? (
        <p className="mt-2 break-words text-xs font-semibold leading-5 text-slate-500">
          The blue square is you. It is drawn on this screen only and is not saved anywhere.
        </p>
      ) : null}
    </div>
  );
}
