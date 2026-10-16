"use client";

// Best-effort client-side crash reporter. Sends to our own /api/errors/client
// endpoint (self-hosted, free-forever). Must never throw — a failed report should
// never surface as a second, user-visible error on top of the one being reported.

import { describeThrown } from "@/lib/error-monitor/describe-thrown";
import { describeDomRewriters } from "@/lib/error-monitor/dom-rewriter";
import { DOM_GUARD_COUNTER_KEY, domGuardMarker } from "@/lib/error-monitor/dom-translate-guard";
import { captureClientErrorInSentry } from "@/lib/observability/sentry-client";

export type ReportClientErrorInput = {
  error: unknown;
  route?: string | null;
  digest?: string | null;
  // React error boundaries provide errorInfo.componentStack (which component tree threw).
  // window.onerror/unhandledrejection cannot, so this is optional.
  componentStack?: string | null;
  // Caller-supplied `key=value` pairs naming WHAT was being done when a caught error fired (the CV
  // viewer's `cvKind=pdf stage=render`). Appended after the browser-state context, which it never
  // replaces. A caller's own catch is invisible to window.onerror, so this is how it says so.
  context?: string | null;
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
/**
 * The attribute names on one element, or `[]` when it is absent — `document.body` is null while the
 * `<head>` is still streaming, and an error thrown then must still report.
 *
 * `getAttributeNames` is the only call here that touches an extension's own additions, and it is
 * cheap: these two elements carry a handful of attributes, never a tree.
 */
function attributeNamesOf(element: Element | null): string[] {
  if (!element || typeof element.getAttributeNames !== "function") return [];
  try {
    return element.getAttributeNames();
  } catch {
    return [];
  }
}

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

    // Whatever rewrote the page's text before React hydrated it — the last standing cause of
    // hydration error #418 here. The `translate="no"` opt-out that used to sit in app/layout.tsx
    // could only ever address the browsers that honour it, and was removed on 2026-09-11 for
    // exactly that reason, so this probe is now the only thing that answers the question. Absent
    // on a clean page, so it adds nothing to an ordinary row.
    const domRewriters = describeDomRewriters({
      bodyAttributeNames: attributeNamesOf(document.body),
      fontElementCount: document.getElementsByTagName("font").length,
      hasMicrosoftTranslateAttribute: document.querySelector("[_msttexthash]") !== null,
      htmlAttributeNames: attributeNamesOf(document.documentElement),
      htmlClassName: typeof document.documentElement.className === "string" ? document.documentElement.className : "",
      htmlLang: document.documentElement.lang || "",
    });
    if (domRewriters.length > 0) parts.push(`domRewriter=${domRewriters.join(",")}`);

    // How many DOM calls the translate guard (app/layout.tsx) redirected on this page before the
    // error. A crash that still happens with a count here was not one the guard could absorb.
    const domGuard = domGuardMarker((window as unknown as Record<string, unknown>)[DOM_GUARD_COUNTER_KEY]);
    if (domGuard) parts.push(domGuard);

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

export function reportClientError({ error, route, digest, componentStack, context }: ReportClientErrorInput): void {
  try {
    // NOT `String(error)`. The browser throws plenty that is not an Error — a rejected fetch
    // body, a Supabase PostgrestError read client-side, any `throw { code, message }` — and all
    // of it stringifies to the constant "[object Object]", which is what made 19 production rows
    // permanently undiagnosable. #2129 fixed the two server writers (instrumentation.ts and the
    // outstation expenses route) and left this one, the third: the browser's own reporter.
    const message = describeThrown(error);
    const stack = error instanceof Error ? (error.stack ?? null) : null;
    const resolvedRoute = route ?? (typeof window !== "undefined" ? window.location.pathname : null);

    const clientContext = [collectClientContext(), context?.trim() || null].filter(Boolean).join(" ") || null;

    const payload = JSON.stringify({
      clientContext,
      componentStack: componentStack ?? null,
      digest: digest ?? null,
      message,
      route: resolvedRoute,
      stack,
    });

    // Sentry sees the same report, on the production host only (sentry-client.ts decides). Fire and forget.
    captureClientErrorInSentry({ componentStack, context: clientContext, digest, error, route: resolvedRoute });

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
