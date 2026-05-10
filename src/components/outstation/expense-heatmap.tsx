"use client";

import Script from "next/script";
import { useEffect, useRef, useState } from "react";

import type { OutstationHeatmapData } from "@/lib/outstation/types";

const panelClassName =
  "rounded-[28px] border border-[#D8E0EA] bg-white/94 shadow-[0_18px_46px_rgba(15,23,42,0.08)] backdrop-blur";

type GoogleMapHandle = {
  fitBounds(bounds: { extend: (point: { lat: number; lng: number }) => void }): void;
};

type GoogleMarkerHandle = {
  setMap(map: GoogleMapHandle | null): void;
};

type GoogleMapConstructor = new (
  container: HTMLDivElement,
  options: {
    center: { lat: number; lng: number };
    mapTypeControl: boolean;
    streetViewControl: boolean;
    zoom: number;
  },
) => GoogleMapHandle;

type GoogleLatLngBoundsConstructor = new () => {
  extend: (position: { lat: number; lng: number }) => void;
};

type GoogleMarkerConstructor = new (options: {
  map: GoogleMapHandle;
  position: { lat: number; lng: number };
  title: string;
}) => GoogleMarkerHandle;

type GoogleMapsApi = {
  importLibrary: (
    library: "maps" | "marker" | string,
  ) => Promise<{
    Map: GoogleMapConstructor;
    LatLngBounds: GoogleLatLngBoundsConstructor;
      Marker?: GoogleMarkerConstructor;
  }>;
  LatLngBounds?: GoogleLatLngBoundsConstructor;
  Map?: GoogleMapConstructor;
  Marker?: GoogleMarkerConstructor;
};

type GoogleMapsLibrary = {
  LatLngBounds?: GoogleLatLngBoundsConstructor;
  Map?: GoogleMapConstructor;
  Marker?: GoogleMarkerConstructor;
};

export function ExpenseHeatmap({
  data,
}: {
  data: OutstationHeatmapData;
}) {
  const browserKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY ?? "";
  const mapRef = useRef<HTMLDivElement | null>(null);
  const mapInstanceRef = useRef<GoogleMapHandle | null>(null);
  const markersRef = useRef<GoogleMarkerHandle[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const googleMaps = (window as { google?: { maps?: GoogleMapsApi } }).google?.maps;
    const mapElement = mapRef.current;
    if (!ready || !mapElement || !googleMaps) return;

    let cancelled = false;

    const run = async () => {
      const mapsLibrary: GoogleMapsLibrary = googleMaps.importLibrary
        ? await googleMaps.importLibrary("maps")
        : {
            LatLngBounds: googleMaps.LatLngBounds,
            Map: googleMaps.Map,
          };
      const markerLibrary: GoogleMapsLibrary = googleMaps.importLibrary
        ? await googleMaps.importLibrary("marker")
        : {
            Marker: googleMaps.Marker,
          };
      if (cancelled) return;

      const mapCtor = mapsLibrary.Map;
      const markerCtor = markerLibrary.Marker ?? mapsLibrary.Marker;
      const latLngBoundsCtor = mapsLibrary.LatLngBounds;
      if (!mapCtor || !markerCtor || !latLngBoundsCtor) return;

      const map =
        mapInstanceRef.current ??
        new mapCtor(mapElement, {
          center: { lat: 26.8206, lng: 30.8025 },
          mapTypeControl: false,
          streetViewControl: false,
          zoom: 6,
        });

      mapInstanceRef.current = map;
      markersRef.current.forEach((marker) => marker.setMap(null));
      markersRef.current = [];

      const bounds = new latLngBoundsCtor();
      data.markers.forEach((marker) => {
        const instance = new markerCtor({
          map,
          position: { lat: marker.latitude, lng: marker.longitude },
          title: marker.employeeName,
        });
        markersRef.current.push(instance);
        bounds.extend({ lat: marker.latitude, lng: marker.longitude });
      });

      if (data.markers.length > 0) {
        map.fitBounds(bounds);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [data.markers, ready]);

  return (
    <div className={`${panelClassName} overflow-hidden p-0`}>
      <Script
        onLoad={() => setReady(true)}
        src={`https://maps.googleapis.com/maps/api/js?key=${browserKey}&loading=async`}
        strategy="afterInteractive"
      />
      <div className="relative overflow-hidden border-b border-[#1F2937] bg-[radial-gradient(circle_at_top_right,rgba(249,115,22,0.24),transparent_34%),linear-gradient(135deg,#080B10_0%,#111827_58%,#24150D_100%)] px-5 py-5 text-white">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-16 -top-20 h-44 w-44 rounded-full bg-[#F97316]/20 blur-3xl"
        />
        <div className="relative z-10">
          <p className="inline-flex rounded-full border border-[#F97316]/35 bg-[#F97316]/12 px-3 py-1 text-xs font-black uppercase tracking-[0.16em] text-[#FDBA74]">Expense Heatmap</p>
          <h2 className="mt-3 text-xl font-black tracking-[-0.03em] text-white">Outstation destination activity</h2>
          <p className="mt-1 text-sm text-[#CBD5E1]">Map request clusters against residence validation and territory variance.</p>
        </div>
      </div>
      <div className="p-5">
        <div className="h-[420px] rounded-[28px] border border-[#DDE6F1] bg-[#F8FAFC] shadow-[inset_0_1px_0_rgba(255,255,255,0.75)]" ref={mapRef} />
      </div>
    </div>
  );
}
