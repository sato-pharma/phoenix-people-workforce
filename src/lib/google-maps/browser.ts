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
    gm_authFailure?: () => void;
    google?: { maps?: GoogleMapsApi };
  }
}

type GoogleMapsBootstrapNamespace = GoogleMapsApi & {
  __ib__?: () => void;
};

export function getLoadedGoogleMaps() {
  return window.google?.maps ?? null;
}

function hasRenderableMapApi(maps: GoogleMapsApi | null) {
  return Boolean(maps?.Map || maps?.importLibrary);
}

function createBootstrapLoader(browserKey: string) {
  const googleRoot = window.google ?? (window.google = {});
  const mapsRoot = (googleRoot.maps ?? (googleRoot.maps = {})) as GoogleMapsBootstrapNamespace;

  if (mapsRoot.importLibrary) {
    return mapsRoot;
  }

  const requestedLibraries = new Set<string>();
  let scriptPromise: Promise<void> | null = null;

  const loadScript = () => {
    if (scriptPromise) return scriptPromise;

    scriptPromise = new Promise<void>((resolve, reject) => {
      const previousAuthFailure = window.gm_authFailure;
      let settled = false;
      const rejectWithMapsConfigError = (message: string) => {
        if (settled) return;
        settled = true;
        script.remove();
        if (mapsRoot.importLibrary === bootstrapImportLibrary) {
          delete mapsRoot.importLibrary;
        }
        delete mapsRoot.__ib__;
        window.gm_authFailure = previousAuthFailure;
        scriptPromise = null;
        reject(new Error(message));
      };
      const params = new URLSearchParams();
      params.set("key", browserKey);
      params.set("v", "weekly");
      params.set("loading", "async");
      params.set("libraries", Array.from(requestedLibraries).join(","));
      params.set("callback", "google.maps.__ib__");

      const script = document.createElement("script");
      script.async = true;
      script.defer = true;
      script.id = "phoenix-google-maps-js";
      script.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
      script.onerror = () => {
        rejectWithMapsConfigError("Google Maps failed to load. Check API restrictions.");
      };
      script.nonce = document.querySelector<HTMLScriptElement>("script[nonce]")?.nonce ?? "";
      window.gm_authFailure = () => {
        previousAuthFailure?.();
        rejectWithMapsConfigError(
          "Google Maps authentication failed. Check Google Cloud billing, enabled APIs, API restrictions, and allowed referrers.",
        );
      };
      mapsRoot.__ib__ = () => {
        if (settled) return;
        settled = true;
        window.gm_authFailure = previousAuthFailure;
        resolve();
      };
      document.head.appendChild(script);
    });

    return scriptPromise;
  };

  function bootstrapImportLibrary(library: string) {
    requestedLibraries.add(library);
    return loadScript().then(() => {
      const liveImportLibrary = window.google?.maps?.importLibrary;
      if (!liveImportLibrary || liveImportLibrary === bootstrapImportLibrary) {
        throw new Error("Google Maps loaded without dynamic library support.");
      }
      return liveImportLibrary(library);
    });
  }

  mapsRoot.importLibrary = bootstrapImportLibrary;

  return mapsRoot;
}

async function ensureCoreLibraries(maps: GoogleMapsApi) {
  if (!maps.importLibrary) return;

  await Promise.all([
    maps.importLibrary("core").catch(() => ({})),
    maps.importLibrary("maps").catch(() => ({})),
  ]);
}

export function loadGoogleMaps(browserKey: string): Promise<GoogleMapsApi> {
  const loaded = getLoadedGoogleMaps();
  if (hasRenderableMapApi(loaded)) {
    return (async () => {
      await ensureCoreLibraries(loaded!);
      return getLoadedGoogleMaps() ?? loaded!;
    })();
  }

  if (!browserKey.trim()) {
    return Promise.reject(new Error("NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY is missing."));
  }

  if (window.__phoenixGoogleMapsPromise) {
    return window.__phoenixGoogleMapsPromise;
  }

  const loadingPromise = (async () => {
    const maps = createBootstrapLoader(browserKey.trim());
    await ensureCoreLibraries(maps);

    const loadedMaps = getLoadedGoogleMaps() ?? maps;
    if (!hasRenderableMapApi(loadedMaps)) {
      throw new Error("Google Maps loaded without maps API.");
    }

    return loadedMaps;
  })();

  const storedPromise = loadingPromise.catch((error) => {
    if (window.__phoenixGoogleMapsPromise === storedPromise) {
      window.__phoenixGoogleMapsPromise = undefined;
    }
    throw error;
  });
  window.__phoenixGoogleMapsPromise = storedPromise;

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
