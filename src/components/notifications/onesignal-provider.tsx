"use client";

import { useEffect, useRef } from "react";
import Script from "next/script";

import { useCspNonce } from "@/components/security/csp-nonce-provider";
import { browserLocalStorage, ownerScopedStorageKey, PUSH_REGISTRATION_MEMO_KEY_BASE } from "@/lib/browser-storage/owner-scoped";
import { detectDeviceType, onesignalAppId, shouldReportPushSubscription, withOneSignal } from "@/lib/notifications/onesignal-client";
import {
  parsePushRegistrationMemo,
  pushRegistrationAlreadyReported,
  type PushRegistrationMemo,
} from "@/lib/notifications/push-registration-memo";

function readRegistrationMemo(key: string | null): PushRegistrationMemo | null {
  if (!key) return null;
  try {
    return parsePushRegistrationMemo(browserLocalStorage()?.getItem(key));
  } catch {
    return null;
  }
}

function writeRegistrationMemo(key: string | null, memo: PushRegistrationMemo): void {
  if (!key) return;
  try {
    browserLocalStorage()?.setItem(key, JSON.stringify(memo));
  } catch {
    /* blocked storage: the next page load reports again, as it always did */
  }
}

function reportSubscriptionState(optedIn: boolean, subscriptionId: string | null, memoKey: string | null = null) {
  if (!subscriptionId) return;
  writeRegistrationMemo(memoKey, { at: Date.now(), id: subscriptionId, optedIn });
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
 *
 * Since 1 Nov 2026 the shell hands it the push identity it already resolved (`pushHrId`: the HR id,
 * or null for a session with none), so the context route is not fetched on every page view; a mount
 * without the prop fetches it as before. And the mount report to push_subscriptions is skipped when
 * this browser reported the same state for the same person inside the last week — it was an upsert
 * on EVERY page load, for every role (pushRegistrationAlreadyReported).
 */
export function OneSignalProvider({ pushHrId }: { pushHrId?: string | null } = {}) {
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
      let identity: string | null = null;
      try {
        if (pushHrId !== undefined) {
          // The shell already said who this is: no request.
          reportsSubscription = shouldReportPushSubscription(true, { data: { hrId: pushHrId } });
          identity = pushHrId;
        } else {
          const response = await fetch("/api/notifications/push/context", { cache: "no-store" });
          const payload = await response.json().catch(() => null);
          reportsSubscription = shouldReportPushSubscription(response.ok, payload);
          identity = typeof payload?.data?.hrId === "string" ? payload.data.hrId : null;
        }
        if (identity) await OneSignal.login(identity);
      } catch {
        // Best-effort — a failed login() just means this browser stays un-targeted
        // until the next mount (e.g. next page load) succeeds.
      }

      if (!reportsSubscription) return;

      try {
        const memoKey = ownerScopedStorageKey(PUSH_REGISTRATION_MEMO_KEY_BASE, identity);
        OneSignal.User.PushSubscription.addEventListener("change", (event) => {
          reportSubscriptionState(event.current.optedIn, event.current.id, memoKey);
        });

        // A returning subscriber's browser may not fire a fresh "change" event this
        // session, so report the current state once on mount too — unless this browser
        // already reported exactly this state for this person inside the last week
        // (push-registration-memo.ts): it was an upsert on every page load.
        const alreadyReported = pushRegistrationAlreadyReported(
          readRegistrationMemo(memoKey),
          { id: OneSignal.User.PushSubscription.id, optedIn: OneSignal.User.PushSubscription.optedIn },
          Date.now(),
        );
        if (!alreadyReported) {
          reportSubscriptionState(OneSignal.User.PushSubscription.optedIn, OneSignal.User.PushSubscription.id, memoKey);
        }
      } catch (error) {
        console.warn("[onesignal] subscription state sync failed", error);
      }
    });
  }, [appId]);

  if (!appId) return null;

  return <Script defer id="onesignal-sdk" nonce={nonce} src="https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js" strategy="afterInteractive" />;
}
