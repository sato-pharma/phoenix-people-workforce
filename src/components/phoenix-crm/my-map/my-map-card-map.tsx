"use client";

/**
 * Phoenix CRM — the real Google map on My map's landing card (owner, 2026-10-28, on the drawn picture: he asked
 * where the map view was). The card's pins on streets and towns, in the full map's square markers and colours.
 *
 * 🔴 LOADED ONLY WHEN THE CARD COMES INTO VIEW. Every map drawn is a billed Google map load, so nothing is loaded
 * until the card is on screen (an `IntersectionObserver`), and then once for the card's life.
 *
 * 🔴 THE DRAWN PICTURE STAYS UNDERNEATH. It is the card's picture until the map has drawn its first tiles, and it
 * stays the picture when there is no browser key or the map fails to load, so the card is never a blank box.
 *
 * 🔴 NO COUNT IS PRINTED ON THE MAP. The snapshot is an even sample of the pins (`SNAPSHOT_POINTS`), so a number
 * on a stack would undercount a big territory; the counts beside the map are the whole truth, and the full map
 * numbers its stacks from every pin.
 *
 * It is a picture, not a tool: no drag, no zoom, no controls. A tap anywhere on it opens My map.
 */

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { importGoogleLibrary, loadGoogleMaps, type GoogleMapHandle, type GoogleMapsApi, type GoogleMarkerHandle } from "@/lib/google-maps/browser";
import { MY_MAP_LAYER_COLOUR, type MyMapSnapshot } from "@/lib/phoenix-crm/my-map-rules";

const SQUARE = "M -9 -9 L 9 -9 L 9 9 L -9 9 z";
/** PM first, so the fewer AM and pharmacy pins are drawn on top of it and never buried. */
const DRAW_ORDER: Record<MyMapSnapshot["points"][number]["layer"], number> = { PM: 0, AM: 1, Pharmacy: 2 };
/** How far beyond the screen the card starts loading, so the map is drawn by the time it is reached. */
const LOAD_AHEAD = "200px";

type LiveMap = GoogleMapHandle & {
  addListener?(eventName: string, handler: () => void): unknown;
};

export function MyMapCardMap({
  browserKey,
  children,
  points,
}: {
  /** The Google Maps browser key, read on the server by the card's loader. */
  browserKey: string;
  /** The drawn picture: shown until the map is ready, and instead of it when the map cannot load. */
  children: ReactNode;
  points: MyMapSnapshot["points"];
}) {
  const router = useRouter();
  const holderRef = useRef<HTMLDivElement | null>(null);
  const elementRef = useRef<HTMLDivElement | null>(null);
  const markersRef = useRef<GoogleMarkerHandle[]>([]);
  const [inView, setInView] = useState(false);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  // Wait for the card to be on screen before a map is loaded at all.
  useEffect(() => {
    const holder = holderRef.current;
    if (!browserKey || !holder || inView) return;
    if (typeof IntersectionObserver === "undefined") {
      // A browser that cannot say when the card is on screen loads the map straight away.
      const timer = window.setTimeout(() => setInView(true), 0);
      return () => window.clearTimeout(timer);
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin: LOAD_AHEAD },
    );
    observer.observe(holder);
    return () => observer.disconnect();
  }, [browserKey, inView]);

  useEffect(() => {
    const element = elementRef.current;
    if (!browserKey || !inView || !element || points.length === 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const googleMaps: GoogleMapsApi = await loadGoogleMaps(browserKey);
        const core = await importGoogleLibrary(googleMaps, "core", { LatLngBounds: googleMaps.LatLngBounds });
        const maps = await importGoogleLibrary(googleMaps, "maps", { Map: googleMaps.Map });
        const marker = await importGoogleLibrary(googleMaps, "marker", { Marker: googleMaps.Marker });
        if (cancelled) return;
        const MapCtor = (maps?.Map as GoogleMapsApi["Map"]) ?? googleMaps.Map;
        const MarkerCtor = (marker?.Marker as GoogleMapsApi["Marker"]) ?? googleMaps.Marker;
        const BoundsCtor = (core?.LatLngBounds as GoogleMapsApi["LatLngBounds"]) ?? googleMaps.LatLngBounds;
        if (!MapCtor || !MarkerCtor) {
          setFailed(true);
          return;
        }
        const map = new MapCtor(element, {
          center: { lat: points[0].lat, lng: points[0].lon },
          clickableIcons: false,
          disableDefaultUI: true,
          draggableCursor: "pointer",
          gestureHandling: "none",
          keyboardShortcuts: false,
          // Shops and offices would crowd the pins on a map this small; streets and towns stay.
          styles: [{ featureType: "poi", stylers: [{ visibility: "off" }] }],
          zoom: 14,
        }) as LiveMap;
        if (points.length > 1 && BoundsCtor) {
          const bounds = new BoundsCtor();
          for (const point of points) bounds.extend({ lat: point.lat, lng: point.lon });
          map.fitBounds(bounds, 16);
        }
        const ordered = [...points].sort((left, right) => DRAW_ORDER[left.layer] - DRAW_ORDER[right.layer]);
        markersRef.current = ordered.map(
          (point, index) =>
            new MarkerCtor({
              clickable: false,
              icon: { fillColor: MY_MAP_LAYER_COLOUR[point.layer], fillOpacity: 1, path: SQUARE, scale: 0.4, strokeColor: "#ffffff", strokeWeight: 1 },
              map,
              position: { lat: point.lat, lng: point.lon },
              zIndex: 1000 + DRAW_ORDER[point.layer] * 1000 + index,
            }),
        );
        map.addListener?.("click", () => router.push("/employee-portals/my-map"));
        // Shown once its first tiles are in, so the picture underneath is never swapped for a grey box.
        map.addListener?.("tilesloaded", () => {
          if (!cancelled) setReady(true);
        });
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      markersRef.current.forEach((handle) => handle.setMap?.(null));
      markersRef.current = [];
    };
  }, [browserKey, inView, points, router]);

  const showMap = ready && !failed;
  return (
    <div className="relative min-w-0" ref={holderRef}>
      <div aria-hidden={showMap ? true : undefined} className={showMap ? "invisible" : undefined}>
        {children}
      </div>
      {browserKey && !failed ? (
        <div
          aria-label="Map of where the validated customers are. Opens My map."
          className={`absolute inset-0 border border-slate-200 bg-slate-100 ${showMap ? "" : "pointer-events-none opacity-0"}`}
          ref={elementRef}
          role="img"
        />
      ) : null}
    </div>
  );
}
