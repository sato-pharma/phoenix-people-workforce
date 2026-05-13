"use client";

import { useEffect, useRef, useState } from "react";

import {
  AdminSectionHeader,
} from "@/components/admin/admin-design-system";
import { Card } from "@/components/ui/card";
import type { GeoDashboardData, GeoMarker } from "@/lib/geo-intelligence/types";
import {
  importGoogleLibrary,
  loadGoogleMaps,
  type GoogleMapsApi as SharedGoogleMapsApi,
} from "@/lib/google-maps/browser";

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

type GoogleMapLibrary = {
  Map?: GoogleMapCtor;
  InfoWindow?: GoogleInfoWindowCtor;
  LatLngBounds?: GoogleBoundsCtor;
};

type GoogleMarkerLibrary = {
  Marker?: GoogleMarkerCtor;
};

type GoogleMapsRuntime = {
  importLibrary?: SharedGoogleMapsApi["importLibrary"];
  InfoWindow?: GoogleInfoWindowCtor;
  LatLngBounds?: GoogleBoundsCtor;
  Map?: GoogleMapCtor;
  Marker?: GoogleMarkerCtor;
};

const panelClassName =
  "rounded-[28px] border border-[#D8E0EA] bg-white/94 shadow-[0_18px_46px_rgba(15,23,42,0.08)] backdrop-blur";

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
  const [googleMaps, setGoogleMaps] = useState<GoogleMapsRuntime | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!browserKey) return;

    let cancelled = false;
    void loadGoogleMaps(browserKey)
      .then((maps) => {
        if (cancelled) return;
        setGoogleMaps(maps as unknown as GoogleMapsRuntime);
        setReady(true);
      })
      .catch(() => setReady(false));

    return () => {
      cancelled = true;
    };
  }, [browserKey]);

  useEffect(() => {
    if (!ready || !mapRef.current || !googleMaps) return;

    const container = mapRef.current;

    let cancelled = false;
    const run = async () => {
      const sharedGoogleMaps = googleMaps as unknown as SharedGoogleMapsApi;
      const mapsLibrary: GoogleMapLibrary = await importGoogleLibrary(sharedGoogleMaps, "maps", {
        InfoWindow: googleMaps.InfoWindow,
        LatLngBounds: googleMaps.LatLngBounds,
        Map: googleMaps.Map,
      });
      const markerLibrary: GoogleMarkerLibrary = await importGoogleLibrary(sharedGoogleMaps, "marker", {
        Marker: googleMaps.Marker,
      });
      if (cancelled) return;

      const MapCtor = mapsLibrary.Map;
      const MarkerCtor = markerLibrary.Marker ?? googleMaps.Marker;
      const InfoWindowCtor = mapsLibrary.InfoWindow ?? googleMaps.InfoWindow;
      const BoundsCtor = mapsLibrary.LatLngBounds ?? googleMaps.LatLngBounds;

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
  }, [data, googleMaps, ready]);

  return (
    <Card className={`${panelClassName} overflow-hidden p-0`}>
      <AdminSectionHeader
        description="Inspect route clusters, vacancies, and trip points on a single visual layer."
        title="Territory map"
      />
      <div className="h-[560px] border-t border-[#E2E8F0] bg-[#F8FAFC]/80 px-4 py-4">
        <div
          className="h-full min-h-[400px] rounded-[28px] border border-[#E2E8F0] bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.75)]"
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
