/**
 * The REAL street map for the printed trip review, drawn by the Maps JavaScript API inside the same
 * headless Chromium that prints the PDF.
 *
 * ── Why not the Static Maps API ──────────────────────────────────────────────
 *
 * Measured 2026-09-29 against both keys in the environment: `staticmap` answers
 * 403 "This API is not activated on your API project" for BOTH `GOOGLE_MAPS_SERVER_KEY` and
 * `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY`, while Geocoding answers 200 with the same key. The Maps
 * JavaScript API, on the other hand, is enabled and is what the review screen already draws with —
 * so the picture the owner sees on screen is reachable, just not through a URL.
 *
 * Chromium is already running to print the document. So the map is drawn the way the screen draws
 * it — same API, same browser key, same encoded polyline off the request row — and screenshotted to
 * a PNG that is inlined in the document. No new Google product to enable, and the paper shows the
 * same streets as the screen.
 *
 * ── The one rule this carries from the screen ────────────────────────────────
 *
 * An unresolved home (null island or the Egypt centroid) is NEVER plotted. That is the defect this
 * whole branch exists for: the review map gated on `!= null`, `(0, 0)` passed, and it drew a pin in
 * the Gulf of Guinea beside a confident distance. The caller decides what is plottable; this refuses
 * to draw a map with no plottable point at all.
 */

import { withChromiumPage } from "@/lib/pdf/chromium";

export type RouteMapPoint = { lat: number; lng: number };

export type RenderedRouteMap = { image: string; usedStreetMap: true };

const WIDTH = 1280;
const HEIGHT = 680;
/** Tiles have to come over the network; beyond this the PDF is more important than the picture. */
const TILE_TIMEOUT_MS = 20_000;

function buildMapHtml(input: {
  apiKey: string;
  destination: RouteMapPoint | null;
  home: RouteMapPoint | null;
  polyline: string;
}): string {
  // The values are numbers and two opaque key strings, injected as JSON — never interpolated into
  // executable positions as raw text.
  const payload = JSON.stringify({
    destination: input.destination,
    home: input.home,
    polyline: input.polyline,
  });
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:#fff;overflow:hidden}
</style></head>
<body>
<script>
  window.__mapReady = false;
  window.__mapError = null;
  const DATA = ${payload};
  function start() {
    try {
      // 🔴 THE CONTAINER IS BUILT HERE, NOT IN THE MARKUP. Reaching this page required navigating
      // to the app's own origin first (the browser key is referrer-restricted), and that page's
      // React is still hydrating when setContent replaces the document — it then re-renders and
      // removes a div written in the markup, so the API answered "Expected mapDiv of type
      // HTMLElement but was passed null" (measured 2026-09-29). Creating the container at the
      // moment the map is made, after React has already done its worst, cannot lose that race.
      document.body.textContent = "";
      const host = document.createElement("div");
      host.id = "map";
      host.style.cssText = "width:${WIDTH}px;height:${HEIGHT}px";
      document.body.appendChild(host);

      const styles = [
        { featureType: "poi", stylers: [{ visibility: "simplified" }] },
        { featureType: "transit", stylers: [{ visibility: "off" }] },
      ];
      const map = new google.maps.Map(host, {
        disableDefaultUI: true,
        // 🔴 RASTER, NEVER A VECTOR MAP. A map id switches Google to the vector renderer, which
        // needs WebGL — and this browser launches with --disable-gpu, so the tiles never arrive
        // and the render times out with no error at all (measured 2026-09-29). JSON styles work
        // on the raster renderer and are what the screen would fall back to anyway.
        styles,
        zoom: 6,
      });
      const bounds = new google.maps.LatLngBounds();
      const path = DATA.polyline ? google.maps.geometry.encoding.decodePath(DATA.polyline) : [];
      if (path.length > 1) {
        new google.maps.Polyline({
          map, path, strokeColor: "#f97316", strokeOpacity: 0.95, strokeWeight: 5,
        });
        path.forEach((point) => bounds.extend(point));
      }
      const pin = (point, label, fill, ink) => {
        new google.maps.Marker({
          map, position: point, label: { text: label, color: ink, fontWeight: "700" },
          icon: {
            path: google.maps.SymbolPath.CIRCLE, scale: 13,
            fillColor: fill, fillOpacity: 1, strokeColor: "#ffffff", strokeWeight: 3,
          },
        });
        bounds.extend(point);
      };
      if (DATA.home) pin(DATA.home, "H", "#0f172a", "#ffffff");
      if (DATA.destination) pin(DATA.destination, "D", "#f97316", "#ffffff");
      if (!bounds.isEmpty()) map.fitBounds(bounds, 64);
      google.maps.event.addListenerOnce(map, "tilesloaded", () => {
        // One more frame, so the markers and the line are composited with the tiles.
        requestAnimationFrame(() => requestAnimationFrame(() => { window.__mapReady = true; }));
      });
    } catch (error) {
      window.__mapError = String(error && error.message ? error.message : error);
    }
  }
  window.gm_authFailure = function () { window.__mapError = "Google rejected the Maps JavaScript key."; };
</script>
<script async defer
  src="https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(input.apiKey)}&libraries=geometry&callback=start"
  onerror="window.__mapError='The Maps JavaScript API could not be loaded.'"></script>
</body></html>`;
}

/**
 * Draw the route on a real street map and return it as a PNG data URI, or null when it cannot be
 * drawn — no key, nothing plottable, Google refusing the key, or the tiles not arriving in time.
 * A map that fails to draw must never fail the PDF: the caller falls back to the plain diagram.
 */
export async function renderRouteStreetMap(input: {
  apiKey: string | null;
  destination: RouteMapPoint | null;
  home: RouteMapPoint | null;
  /** The app's own origin, so the referrer-restricted browser key is accepted. See below. */
  origin?: string | null;
  polyline: string | null | undefined;
}): Promise<RenderedRouteMap | null> {
  if (!input.apiKey) return null;
  if (!input.home && !input.destination) return null;

  try {
    return await withChromiumPage(async (page) => {
      await page.setViewport({ deviceScaleFactor: 2, height: HEIGHT, width: WIDTH });
      // 🔴 ORIGIN FIRST, CONTENT SECOND. The browser key is HTTP-referrer restricted to the app's
      // domain, and a page built by `setContent` alone is `about:blank`, which matches no referrer
      // — Google answers `gm_authFailure` and draws nothing (measured 2026-09-29, both keys). A
      // navigation sets the document URL, and `setContent` then replaces the document while KEEPING
      // that URL, so the map request carries a referrer the key allows. On the server this is the
      // app asking its own origin; if it cannot be reached, the map simply falls back.
      // 🔴 A SCRIPTLESS PATH, not the app's home page. Landing on a real app page leaves Next.js
      // hydrating, and React then re-renders over the document `setContent` just wrote — the map
      // div vanishes and the API answers "Expected mapDiv of type HTMLElement but was passed null"
      // (measured 2026-09-29). It must be an HTML page: a JSON endpoint like /api/healthz is the same
      // ORIGIN, but scripts do not execute inside a JSON document, so nothing ran at all. /login is
      // HTML, unauthenticated, and its React is handled by building the map container in the
      // callback rather than in the markup.
      const origin = String(input.origin ?? "").trim().replace(/\/+$/, "");
      // 🔴 THE POLICY OF THE BORROWED PAGE MUST NOT APPLY (audit, 2026-10-26, point 29). /login now
      // sends a nonce Content-Security-Policy with 'strict-dynamic', and `setContent` keeps the
      // document it replaced — its policy included — so the map's inline script, the Maps API script
      // and its onerror would all be refused. The map is our own markup in our own headless browser,
      // so the page ignores that policy; puppeteer applies it to the NEXT navigation, hence here.
      await page.setBypassCSP(true);
      if (origin) {
        try {
          await page.goto(`${origin}/login`, { timeout: 15_000, waitUntil: "domcontentloaded" });
        } catch {
          console.warn("[outstation-review-pdf] street map: could not reach the app origin for the referrer");
        }
      }
      await page.setContent(
        buildMapHtml({
          apiKey: input.apiKey as string,
          destination: input.destination,
          home: input.home,
          polyline: String(input.polyline ?? ""),
        }),
        { timeout: 30_000, waitUntil: "domcontentloaded" },
      );

      // The page type exposes `evaluate` and nothing to wait on, so this polls it.
      const deadline = Date.now() + TILE_TIMEOUT_MS;
      let ready = false;
      while (Date.now() < deadline) {
        const state = (await page.evaluate(
          "JSON.stringify({ ready: window.__mapReady === true, error: window.__mapError })",
        )) as string;
        const { error, ready: isReady } = JSON.parse(String(state)) as { error: string | null; ready: boolean };
        if (error) {
          console.warn(`[outstation-review-pdf] street map: ${error}`);
          return null;
        }
        if (isReady) {
          ready = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!ready) {
        console.warn("[outstation-review-pdf] street map: tiles did not load in time");
        return null;
      }

      const bytes = await page.screenshot({ type: "png" });
      return { image: `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`, usedStreetMap: true };
    });
  } catch (error) {
    console.warn("[outstation-review-pdf] street map render failed", error);
    return null;
  }
}
