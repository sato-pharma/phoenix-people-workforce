"use client";

// Best-effort client-side crash reporter. Sends to our own /api/errors/client
// endpoint (self-hosted, free-forever). Must never throw — a failed report should
// never surface as a second, user-visible error on top of the one being reported.

export type ReportClientErrorInput = {
  error: unknown;
  route?: string | null;
  digest?: string | null;
  // React error boundaries provide errorInfo.componentStack (which component tree threw).
  // window.onerror/unhandledrejection cannot, so this is optional.
  componentStack?: string | null;
};

type NetworkInformationLike = {
  downlink?: number;
  effectiveType?: string;
  rtt?: number;
  saveData?: boolean;
};

let lifecycleBound = false;
let unloadStarted = false;
let errorSequence = 0;

function ensureLifecycleListeners(): void {
  if (lifecycleBound || typeof window === "undefined") return;
  lifecycleBound = true;
  // `pagehide` only — deliberately NOT `beforeunload`, which makes a page ineligible for
  // the back/forward cache in several browsers. A reporter must not cost real navigation
  // performance just to observe itself.
  window.addEventListener(
    "pagehide",
    () => {
      unloadStarted = true;
    },
    { capture: true },
  );
}

/**
 * Browser state at throw time, for errors whose cause lives in *when* they fired rather
 * than in the stack. The motivating case is React's streaming `completeSegment` ($RS)
 * failing with "Cannot read properties of null (reading 'parentNode')" on
 * /employee-portals: the placeholder node it was about to swap had already left the DOM,
 * and the minified stack cannot say why.
 *
 * `readyState` is the discriminator — `loading` means the initial HTML stream was still
 * in flight when the segment was orphaned; `complete` means it was not, which points at
 * the DOM being mutated from outside React instead.
 *
 * NOT captured: client-side (App Router) navigations. Detecting those needs history
 * monkey-patching, which is not worth the blast radius for this; `pagehide` covers only
 * real unloads and bfcache freezes.
 */
function collectClientContext(): string | null {
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  try {
    ensureLifecycleListeners();
    errorSequence += 1;

    // A burst shares one page load, so `seq` tells a single failing segment apart from
    // the 16-23 that fail together when a whole streamed tree is orphaned at once.
    const parts = [
      `seq=${errorSequence}`,
      `readyState=${document.readyState}`,
      `visibility=${document.visibilityState}`,
      `unloading=${unloadStarted}`,
    ];

    const sinceNavMs = Math.round(performance.now());
    if (Number.isFinite(sinceNavMs)) parts.push(`sinceNavMs=${sinceNavMs}`);

    const [navigationEntry] = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
    if (navigationEntry?.type) parts.push(`navType=${navigationEntry.type}`);

    const connection = (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
    if (connection) {
      if (connection.effectiveType) parts.push(`net=${connection.effectiveType}`);
      if (typeof connection.downlink === "number") parts.push(`downlinkMbps=${connection.downlink}`);
      if (typeof connection.rtt === "number") parts.push(`rttMs=${connection.rtt}`);
      if (typeof connection.saveData === "boolean") parts.push(`saveData=${connection.saveData}`);
    }

    return parts.join(" ");
  } catch {
    // Context is a diagnostic nicety — never let collecting it cost us the report itself.
    return null;
  }
}

export function reportClientError({ error, route, digest, componentStack }: ReportClientErrorInput): void {
  try {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? (error.stack ?? null) : null;
    const resolvedRoute = route ?? (typeof window !== "undefined" ? window.location.pathname : null);

    const payload = JSON.stringify({
      clientContext: collectClientContext(),
      componentStack: componentStack ?? null,
      digest: digest ?? null,
      message,
      route: resolvedRoute,
      stack,
    });

    void fetch("/api/errors/client", {
      body: payload,
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      method: "POST",
    }).catch(() => {
      // Swallow — reporting is best-effort.
    });
  } catch {
    // Swallow — reporting must never throw.
  }
}
