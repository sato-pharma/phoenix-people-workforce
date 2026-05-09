"use client";

export type GoogleLatLngLiteral = { lat: number; lng: number };

export type GoogleMapHandle = {
  fitBounds(bounds: GoogleLatLngBoundsHandle, padding?: number): void;
};

export type GoogleLatLngBoundsHandle = {
  extend(position: GoogleLatLngLiteral | unknown): void;
};

export type GoogleMarkerHandle = {
  addListener?(eventName: string, handler: () => void): void;
  map?: GoogleMapHandle | null;
  setMap?(map: GoogleMapHandle | null): void;
};

export type GoogleInfoWindowHandle = {
  open(options: { anchor: GoogleMarkerHandle; map: GoogleMapHandle }): void;
  setContent(content: string): void;
};

export type GooglePolylineHandle = {
  setMap(map: GoogleMapHandle | null): void;
};

export type GoogleGeocoderResult = {
  results: Array<{ geometry: { location: unknown } }>;
};

export type GoogleMapsApi = {
  Geocoder?: new () => { geocode(input: { address: string }): Promise<GoogleGeocoderResult> };
  InfoWindow?: new () => GoogleInfoWindowHandle;
  LatLngBounds?: new () => GoogleLatLngBoundsHandle;
  Map?: new (element: HTMLDivElement, options: Record<string, unknown>) => GoogleMapHandle;
  Marker?: new (options: Record<string, unknown>) => GoogleMarkerHandle;
  Polyline?: new (options: Record<string, unknown>) => GooglePolylineHandle;
  SymbolPath?: { CIRCLE: unknown };
  importLibrary?: (library: string) => Promise<Record<string, unknown>>;
  marker?: {
    AdvancedMarkerElement?: new (options: Record<string, unknown>) => GoogleMarkerHandle;
  };
};

declare global {
  interface Window {
    __phoenixGoogleMapsPromise?: Promise<GoogleMapsApi>;
    google?: { maps?: GoogleMapsApi };
  }
}

export function getLoadedGoogleMaps() {
  return window.google?.maps ?? null;
}

export function loadGoogleMaps(browserKey: string): Promise<GoogleMapsApi> {
  const loaded = getLoadedGoogleMaps();
  if (loaded) return Promise.resolve(loaded);

  if (!browserKey.trim()) {
    return Promise.reject(new Error("NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY is missing."));
  }

  if (window.__phoenixGoogleMapsPromise) {
    return window.__phoenixGoogleMapsPromise;
  }

  window.__phoenixGoogleMapsPromise = new Promise((resolve, reject) => {
    const existing = document.getElementById("phoenix-google-maps-js") as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener("load", () => {
        const maps = getLoadedGoogleMaps();
        if (maps) {
          resolve(maps);
        } else {
          reject(new Error("Google Maps loaded without maps API."));
        }
      }, { once: true });
      existing.addEventListener("error", () => reject(new Error("Google Maps failed to load.")), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.async = true;
    script.defer = true;
    script.id = "phoenix-google-maps-js";
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(browserKey)}&v=weekly&loading=async`;
    script.onload = () => {
      const maps = getLoadedGoogleMaps();
      if (maps) {
        resolve(maps);
      } else {
        reject(new Error("Google Maps loaded without maps API."));
      }
    };
    script.onerror = () => reject(new Error("Google Maps failed to load. Check API restrictions."));
    document.head.appendChild(script);
  });

  return window.__phoenixGoogleMapsPromise;
}

export async function importGoogleLibrary<T extends Record<string, unknown>>(
  googleMaps: GoogleMapsApi,
  library: string,
  fallback: T,
): Promise<T> {
  if (!googleMaps.importLibrary) return fallback;
  return (await googleMaps.importLibrary(library)) as T;
}
