"use client";

import Script from "next/script";
import { useEffect, useRef, useState } from "react";

import { adminPanelClassName } from "@/components/admin/admin-design-system";
import type { OutstationHeatmapData } from "@/lib/outstation/types";

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
      const mapsLibrary: any = googleMaps.importLibrary
        ? await googleMaps.importLibrary("maps")
        : {
            LatLngBounds: googleMaps.LatLngBounds,
            Map: googleMaps.Map,
          };
      const markerLibrary: any = googleMaps.importLibrary
        ? await googleMaps.importLibrary("marker")
        : {
            Marker: googleMaps.Marker,
          };
      if (cancelled) return;

      const mapCtor = mapsLibrary.Map;
      const markerCtor = markerLibrary.Marker ?? mapsLibrary.Marker;
      if (!markerCtor) return;
      const latLngBoundsCtor = mapsLibrary.LatLngBounds;

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
    <div className={`${adminPanelClassName} p-5`}>
      <Script
        onLoad={() => setReady(true)}
        src={`https://maps.googleapis.com/maps/api/js?key=${browserKey}&loading=async`}
        strategy="afterInteractive"
      />
      <p className="text-xs font-black uppercase tracking-[0.16em] text-[#64748B]">Expense Heatmap</p>
      <h2 className="mt-1 text-xl font-black tracking-[-0.03em] text-[#0F172A]">Outstation destination activity</h2>
      <div className="mt-4 h-[420px] rounded-[14px] border border-[#DDE6F1] bg-[#F8FAFC]" ref={mapRef} />
    </div>
  );
}
