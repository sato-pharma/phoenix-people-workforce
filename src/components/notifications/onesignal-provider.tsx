"use client";

import { useEffect, useRef } from "react";
import Script from "next/script";

import { useCspNonce } from "@/components/security/csp-nonce-provider";
import { detectDeviceType, onesignalAppId, shouldReportPushSubscription, withOneSignal } from "@/lib/notifications/onesignal-client";

function reportSubscriptionState(optedIn: boolean, subscriptionId: string | null) {
  if (!subscriptionId) return;
  void fetch("/api/notifications/push/register", {
    body: JSON.stringify({
      deviceType: detectDeviceType(),
      onesignalSubscriptionId: subscriptionId,
      optedIn,
      userAgent: navigator.userAgent,
    }),
    headers: { "Content-Type": "application/json" },
    keepalive: true,
    method: "POST",
  }).catch(() => {
    // Best-effort telemetry sync — a failed report just means push_subscriptions
    // stays stale until the next change event or page load.
  });
}

/**
 * Mounted once on every authenticated page (admin shell + employee portal). Loads the
 * OneSignal Web SDK, associates this browser with the signed-in HR_ID via
 * OneSignal.login() so server-side sends can target it, and mirrors this browser's
 * subscription state into push_subscriptions so Phoenix knows who is actually
 * reachable by push without calling OneSignal's API per send. Renders nothing —
 * pure side effect — and is a complete no-op until NEXT_PUBLIC_ONESIGNAL_APP_ID is set.
 */
export function OneSignalProvider() {
  const appId = onesignalAppId();
  const initialized = useRef(false);
  // The page policy runs a script tag only with this request's nonce (src/lib/security/content-security-policy.ts).
  const nonce = useCspNonce();

  useEffect(() => {
    if (!appId || initialized.current) return;
    initialized.current = true;

    withOneSignal(async (OneSignal) => {
      try {
        await OneSignal.init({
          allowLocalhostAsSecureOrigin: process.env.NODE_ENV !== "production",
          appId,
        });
      } catch (error) {
        // A misconfigured/unrecognized App ID (e.g. NEXT_PUBLIC_ONESIGNAL_APP_ID set to a
        // stale or wrong value) would otherwise become an unhandled rejection on every
        // authenticated page load — swallow it here rather than letting it become
        // recurring noise. It's console-visible for local debugging either way.
        console.warn("[onesignal] init failed — push notifications unavailable this session", error);
        return;
      }

      // A session with no push identity (a test account, View as Seat) never registers this browser:
      // the server refuses a test account's register, and it was refused on every page it opened.
      let reportsSubscription = true;
      try {
        const response = await fetch("/api/notifications/push/context", { cache: "no-store" });
        const payload = await response.json().catch(() => null);
        reportsSubscription = shouldReportPushSubscription(response.ok, payload);
        const hrId = typeof payload?.data?.hrId === "string" ? payload.data.hrId : null;
        if (hrId) await OneSignal.login(hrId);
      } catch {
        // Best-effort — a failed login() just means this browser stays un-targeted
        // until the next mount (e.g. next page load) succeeds.
      }

      if (!reportsSubscription) return;

      try {
        OneSignal.User.PushSubscription.addEventListener("change", (event) => {
          reportSubscriptionState(event.current.optedIn, event.current.id);
        });

        // A returning subscriber's browser may not fire a fresh "change" event this
        // session, so report the current state once on mount too.
        reportSubscriptionState(OneSignal.User.PushSubscription.optedIn, OneSignal.User.PushSubscription.id);
      } catch (error) {
        console.warn("[onesignal] subscription state sync failed", error);
      }
    });
  }, [appId]);

  if (!appId) return null;

  return <Script defer id="onesignal-sdk" nonce={nonce} src="https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js" strategy="afterInteractive" />;
}
