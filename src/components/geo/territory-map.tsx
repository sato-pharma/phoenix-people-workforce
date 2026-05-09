"use client";

import Script from "next/script";
import { useEffect, useRef, useState } from "react";

import {
  AdminSectionHeader,
  adminPanelClassName,
} from "@/components/admin/admin-design-system";
import { Card } from "@/components/ui/card";
import type { GeoDashboardData, GeoMarker } from "@/lib/geo-intelligence/types";

type GoogleMapOptions = {
  center: { lat: number; lng: number };
  mapTypeControl: boolean;
  streetViewControl: boolean;
  zoom: number;
};

type GoogleMap = {
  fitBounds: (bounds: GoogleBounds, padding: number) => void;
};

type GoogleMapCtor = new (map: HTMLDivElement, options: GoogleMapOptions) => GoogleMap;

type GoogleMarker = {
  addListener: (event: "click", handler: () => void) => void;
  setMap: (map: GoogleMap | null) => void;
};

type GoogleMarkerCtor = new (options: {
  icon: GoogleMapSymbol;
  map: GoogleMap;
  position: { lat: number; lng: number };
  title: string;
}) => GoogleMarker;

type GoogleMapSymbol = {
  fillColor: string;
  fillOpacity: number;
  path: "CIRCLE";
  scale: number;
  strokeColor: string;
  strokeWeight: number;
};

type GoogleInfoWindow = {
  setContent: (content: string) => void;
  open: (settings: { anchor: GoogleMarker; map: GoogleMap }) => void;
};

type GoogleInfoWindowCtor = new () => GoogleInfoWindow;

type GoogleBounds = {
  extend: (point: { lat: number; lng: number }) => void;
};

type GoogleBoundsCtor = new () => GoogleBounds;

type GoogleMapsLibrary = {
  importLibrary: (name: "maps" | "marker") => Promise<unknown>;
};

type GoogleMapLibrary = {
  Map: GoogleMapCtor;
  InfoWindow: GoogleInfoWindowCtor;
  LatLngBounds: GoogleBoundsCtor;
};

type GoogleMarkerLibrary = {
  Marker?: GoogleMarkerCtor;
};

type GoogleCoreMaps = {
  maps?: GoogleMapsLibrary & {
    Map?: GoogleMapCtor;
    InfoWindow?: GoogleInfoWindowCtor;
    LatLngBounds?: GoogleBoundsCtor;
    Marker?: GoogleMarkerCtor;
  };
};

type WindowWithGoogle = Window & {
  google?: GoogleCoreMaps;
};

function markerColor(marker: GeoMarker) {
  switch (marker.status) {
    case "high_risk":
      return "#dc2626";
    case "review_required":
      return "#f59e0b";
    case "vacant":
    case "unassigned":
      return "#64748b";
    case "covered":
    case "normal":
      return "#f97316";
    default:
      return "#f97316";
  }
}

export function TerritoryMap({ data }: { data: GeoDashboardData }) {
  const browserKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY ?? "";
  const mapRef = useRef<HTMLDivElement | null>(null);
  const mapInstanceRef = useRef<GoogleMap | null>(null);
  const markersRef = useRef<GoogleMarker[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!ready || !mapRef.current) return;

    const googleMaps = (window as WindowWithGoogle).google?.maps;
    if (!googleMaps) return;

    const container = mapRef.current;

    let cancelled = false;
    const run = async () => {
      const mapsLibrary = googleMaps.importLibrary
        ? ((await googleMaps.importLibrary("maps")) as GoogleMapLibrary)
        : ({
            InfoWindow: googleMaps.InfoWindow,
            LatLngBounds: googleMaps.LatLngBounds,
            Map: googleMaps.Map,
          } satisfies GoogleMapLibrary);
      const markerLibrary = googleMaps.importLibrary
        ? ((await googleMaps.importLibrary("marker")) as GoogleMarkerLibrary)
        : ({ Marker: googleMaps.Marker } satisfies GoogleMarkerLibrary);
      if (cancelled) return;

      const MapCtor = mapsLibrary.Map;
      const MarkerCtor = markerLibrary.Marker ?? googleMaps.Marker;
      const InfoWindowCtor = googleMaps.InfoWindow;
      const BoundsCtor = googleMaps.LatLngBounds;

      if (!MapCtor || !MarkerCtor || !InfoWindowCtor || !BoundsCtor) {
        return;
      }

      const map = mapInstanceRef.current ?? new MapCtor(container, {
          center: { lat: 26.8206, lng: 30.8025 },
          mapTypeControl: false,
          streetViewControl: false,
          zoom: 6,
        });

      mapInstanceRef.current = map;
      markersRef.current.forEach((marker) => marker.setMap(null));
      markersRef.current = [];

      const bounds = new BoundsCtor();
      const infoWindow = new InfoWindowCtor();

      data.territoryMarkers.forEach((item) => {
        const marker = new MarkerCtor({
          icon: markerIcon(item),
          map,
          position: { lat: item.latitude, lng: item.longitude },
          title: item.label,
        });

        marker.addListener("click", () => {
          infoWindow.setContent(
            `<div style="min-width:180px;padding:6px">
              <div style="font-weight:700;color:#0f172a">${item.label}</div>
              <div style="font-size:12px;color:#475569;margin-top:4px">${item.source.replace(/_/g, " ")}</div>
              <div style="font-size:12px;color:#475569;margin-top:4px">${item.meta ?? ""}</div>
            </div>`,
          );
          infoWindow.open({ anchor: marker, map });
        });

        markersRef.current.push(marker);
        bounds.extend({ lat: item.latitude, lng: item.longitude });
      });

      if (data.territoryMarkers.length > 0) {
        map.fitBounds(bounds, 52);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [data, ready]);

  return (
    <Card className={`${adminPanelClassName} overflow-hidden p-0`}>
      <Script
        onLoad={() => setReady(true)}
        src={`https://maps.googleapis.com/maps/api/js?key=${browserKey}&libraries=places&loading=async`}
        strategy="afterInteractive"
      />
      <AdminSectionHeader
        description="Inspect route clusters, vacancies, and trip points on a single visual layer."
        title="Territory map"
      />
      <div className="h-[560px] border-t border-[#E2E8F0] bg-[#F8FAFC] px-4 py-4">
        <div
          className="h-full min-h-[400px] rounded-[12px] border border-[#E2E8F0] bg-white"
          ref={mapRef}
        />
      </div>
    </Card>
  );
}

function markerIcon(marker: GeoMarker): GoogleMapSymbol {
  return {
    fillColor: markerColor(marker),
    fillOpacity: 1,
    path: "CIRCLE",
    scale: marker.source === "vacancy" ? 9 : 7,
    strokeColor: "#ffffff",
    strokeWeight: 2,
  };
}
