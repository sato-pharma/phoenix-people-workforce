"use client";

/**
 * Managed Google Play — the console where the Phoenix app is published to the fleet.
 *
 * DESIGN IDENTITY is the device register's, deliberately (AGENTS.md §4: match the sibling pages,
 * never invent a one-off look) — the same `PremiumHero`, the same slate borders, the same square
 * corners, the same 9px uppercase micro-labels. It is that page's twin because it is the other half
 * of the same job: the register records which tablet a rep holds, this decides what is on it.
 *
 * IT FITS THE SCREEN. The iframe is Google's and its contents cannot be restyled, but the frame
 * itself is `width: 100%`, so it reflows rather than forcing the page sideways. Everything Phoenix
 * draws around it wraps and never truncates.
 *
 * 🔴 THE IFRAME CANNOT BE A PLAIN `<iframe>` TAG. Google serves it through `gapi.iframes`, which
 * sets up the cross-origin RPC channel the embedded pages talk over. A hand-written tag pointing at
 * the same URL renders a frame that loads and then does nothing — no upload dialog, no errors, no
 * clue. That is why `apis.google.com/js/api.js` is loaded first and the child is opened through the
 * context rather than declared in JSX.
 *
 * 🔴 THE TOKEN IS MINTED PER OPEN AND NEVER STORED. Web tokens expire, so a cached one produces an
 * iframe that works in the morning and is blank after lunch. Every open asks the server for a fresh
 * URL. The URL carries a bearer credential for the whole enterprise, so it is held in a ref for the
 * life of the open and never put in state that could be serialised, logged or sent anywhere.
 */

import { ExternalLink, Loader2, ShieldAlert, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { PremiumHero } from "@/components/ui/premium-hero";

/** The minimum of Google's loader this file touches. Declared rather than pulling in a types pkg. */
type GapiIframesContext = {
  openChild: (options: {
    url: string;
    where: HTMLElement;
    attributes?: Record<string, unknown>;
  }) => unknown;
};

declare global {
  interface Window {
    gapi?: {
      load: (module: string, callback: () => void) => void;
      iframes?: { getContext: () => GapiIframesContext };
    };
  }
}

const GAPI_LOADER_URL = "https://apis.google.com/js/api.js";

/**
 * Load Google's API script once per document.
 *
 * Resolving on an already-present tag matters: React strict mode mounts twice in development, and a
 * second `<script>` for the same URL re-initialises `gapi` underneath the first iframe.
 */
function loadGapi(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined") {
      reject(new Error("Managed Google Play can only open in a browser."));
      return;
    }
    if (window.gapi?.iframes) {
      resolve();
      return;
    }
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GAPI_LOADER_URL}"]`);
    const onLoaded = () => {
      if (!window.gapi) {
        reject(new Error("Google's API script loaded but did not define gapi."));
        return;
      }
      window.gapi.load("gapi.iframes", () => resolve());
    };
    if (existing) {
      if (window.gapi) onLoaded();
      else existing.addEventListener("load", onLoaded, { once: true });
      existing.addEventListener("error", () => reject(new Error("Google's API script failed to load.")), {
        once: true,
      });
      return;
    }
    const script = document.createElement("script");
    script.async = true;
    script.src = GAPI_LOADER_URL;
    script.addEventListener("load", onLoaded, { once: true });
    script.addEventListener(
      "error",
      () =>
        reject(
          new Error(
            "Google's API script failed to load. If this page's Content-Security-Policy does not " +
              "allow https://apis.google.com in script-src, the browser blocks it silently.",
          ),
        ),
      { once: true },
    );
    document.head.append(script);
  });
}

export type ManagedPlayConsoleProps = {
  /** Whether `ANDROID_MANAGEMENT_ENTERPRISE_NAME` is set — the binding everything waits on. */
  enterpriseBound: boolean;
  /** Set when the owner has just completed the signup, so the page can show what to configure. */
  newEnterpriseName: string | null;
  /** Carried back from Google's callback when the enrolment did not complete. */
  signupError: string | null;
};

export function ManagedPlayConsole({
  enterpriseBound,
  newEnterpriseName,
  signupError,
}: ManagedPlayConsoleProps) {
  const [status, setStatus] = useState<"idle" | "opening" | "open" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);
  const [signupBusy, setSignupBusy] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const openedRef = useRef(false);

  const openIframe = useCallback(async () => {
    if (!containerRef.current) return;
    setStatus("opening");
    setError(null);
    try {
      const response = await fetch("/api/devices/managed-play", { method: "POST" });
      const payload = (await response.json()) as { iframeUrl?: string; message?: string };
      if (!response.ok || !payload.iframeUrl) {
        throw new Error(payload.message ?? "Could not open managed Google Play.");
      }
      await loadGapi();
      const context = window.gapi?.iframes?.getContext();
      if (!context) throw new Error("Google's iframe context was not available.");

      containerRef.current.replaceChildren();
      context.openChild({
        attributes: { style: "width: 100%; height: 720px; border: 0;" },
        url: payload.iframeUrl,
        where: containerRef.current,
      });
      setStatus("open");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not open managed Google Play.");
      setStatus("failed");
    }
  }, []);

  useEffect(() => {
    if (!enterpriseBound || openedRef.current) return;
    openedRef.current = true;
    void openIframe();
  }, [enterpriseBound, openIframe]);

  const startSignup = useCallback(async () => {
    setSignupBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/devices/managed-play/signup", { method: "POST" });
      const payload = (await response.json()) as { signupUrl?: string; message?: string };
      if (!response.ok || !payload.signupUrl) {
        throw new Error(payload.message ?? "Could not start the signup.");
      }
      // A full navigation, not a popup: Google's enrolment is several screens and a popup blocker
      // eats it silently. The signup-name cookie is sameSite=lax, so the return leg still carries it.
      window.location.assign(payload.signupUrl);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not start the signup.");
      setSignupBusy(false);
    }
  }, []);

  return (
    <div className="space-y-6">
      <PremiumHero
        kicker="Company devices"
        subtitle="Publish the Phoenix app to the company's own managed Google Play store, and choose what else a rep's tablet may install. Apps published here are private to Sato Pharma and never appear on the public Play Store."
        title="Managed Google Play"
      />

      {signupError ? (
        <div className="border border-amber-300 bg-amber-50 p-4">
          <div className="flex items-start gap-3">
            <TriangleAlert aria-hidden className="mt-0.5 size-5 shrink-0 text-amber-700" />
            <div className="space-y-1">
              <p className="text-[9px] font-black uppercase tracking-[0.14em] text-amber-800">
                The signup did not finish
              </p>
              <p className="break-words text-sm text-amber-900">{signupError}</p>
            </div>
          </div>
        </div>
      ) : null}

      {newEnterpriseName ? (
        <div className="border border-emerald-300 bg-emerald-50 p-4">
          <p className="text-[9px] font-black uppercase tracking-[0.14em] text-emerald-800">
            The enterprise is created
          </p>
          <p className="mt-2 text-sm text-emerald-900">
            Set this as <span className="font-semibold">ANDROID_MANAGEMENT_ENTERPRISE_NAME</span> on
            the production service, then reload this page. It is the binding every device command
            and every app on the fleet goes through.
          </p>
          <p className="mt-2 break-all border border-emerald-300 bg-white p-3 font-mono text-sm text-emerald-950">
            {newEnterpriseName}
          </p>
        </div>
      ) : null}

      {!enterpriseBound ? (
        <div className="space-y-4 border border-slate-200 bg-white p-5">
          <div>
            <p className="text-[9px] font-black uppercase tracking-[0.14em] text-slate-500">
              Setup — one time
            </p>
            <h2 className="mt-1 text-lg font-black text-slate-900">
              Phoenix is not bound to an Android Enterprise yet
            </h2>
            <p className="mt-2 max-w-3xl text-sm text-slate-600">
              The binding is what lets Phoenix push policies to a tablet and publish apps to the
              company&rsquo;s own store. Creating it costs nothing: Google creates the Play developer
              account for the organisation itself and waives the US$25 registration fee, so no Play
              Console account, card or D-U-N-S number is involved.
            </p>
          </div>

          <div className="border border-slate-300 bg-slate-50 p-4">
            <div className="flex items-start gap-3">
              <ShieldAlert aria-hidden className="mt-0.5 size-5 shrink-0 text-slate-700" />
              <div className="space-y-2 text-sm text-slate-700">
                <p className="font-semibold text-slate-900">
                  Read this before you sign in — it cannot be undone later.
                </p>
                <p>
                  The Google account you sign in with becomes the permanent owner of the
                  company&rsquo;s device fleet. The enterprise binds to it, the free Play developer
                  account hangs off it, and neither can be transferred to another account afterwards.
                  Use a company account that will outlast any one person, not a personal one.
                </p>
                <p>
                  Apps published through this route are permanently private and can never be turned
                  into a public Play Store listing. That is the right trade here, and it is one-way.
                </p>
              </div>
            </div>
          </div>

          <button
            className="inline-flex items-center gap-2 border border-slate-900 bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
            disabled={signupBusy}
            onClick={() => void startSignup()}
            type="button"
          >
            {signupBusy ? (
              <Loader2 aria-hidden className="size-4 animate-spin" />
            ) : (
              <ExternalLink aria-hidden className="size-4" />
            )}
            {signupBusy ? "Opening Google…" : "Start the Android Enterprise signup"}
          </button>

          {error ? <p className="break-words text-sm text-rose-700">{error}</p> : null}
        </div>
      ) : (
        <div className="space-y-3 border border-slate-200 bg-white p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[9px] font-black uppercase tracking-[0.14em] text-slate-500">
                Private apps
              </p>
              <p className="mt-1 text-sm text-slate-600">
                Upload the Phoenix app here. A private app is approved for Sato Pharma automatically
                and is usually ready to distribute within ten minutes.
              </p>
            </div>
            <button
              className="inline-flex items-center gap-2 border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
              disabled={status === "opening"}
              onClick={() => void openIframe()}
              type="button"
            >
              {status === "opening" ? (
                <Loader2 aria-hidden className="size-4 animate-spin" />
              ) : null}
              {status === "opening" ? "Opening…" : "Reload the store"}
            </button>
          </div>

          {error ? (
            <div className="border border-rose-300 bg-rose-50 p-4">
              <p className="text-[9px] font-black uppercase tracking-[0.14em] text-rose-800">
                Managed Google Play did not open
              </p>
              <p className="mt-1 break-words text-sm text-rose-900">{error}</p>
            </div>
          ) : null}

          <div className="border border-slate-200" ref={containerRef}>
            {status !== "open" ? (
              <div className="flex items-center justify-center gap-2 p-10 text-sm text-slate-500">
                {status === "failed" ? null : <Loader2 aria-hidden className="size-4 animate-spin" />}
                {status === "failed" ? "Nothing is loaded." : "Opening managed Google Play…"}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
