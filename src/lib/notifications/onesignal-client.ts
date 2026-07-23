export type OneSignalPushSubscriptionChangeEvent = {
  current: { id: string | null; optedIn: boolean };
};

export type OneSignalSdk = {
  init: (options: { allowLocalhostAsSecureOrigin?: boolean; appId: string }) => Promise<void>;
  login: (externalId: string) => Promise<void>;
  logout: () => Promise<void>;
  Notifications: {
    permission: boolean;
    requestPermission: () => Promise<void>;
  };
  User: {
    PushSubscription: {
      addEventListener: (event: "change", handler: (event: OneSignalPushSubscriptionChangeEvent) => void) => void;
      id: string | null;
      optedIn: boolean;
      optIn: () => Promise<void>;
    };
  };
};

declare global {
  interface Window {
    OneSignal?: OneSignalSdk;
    OneSignalDeferred?: Array<(OneSignal: OneSignalSdk) => void | Promise<void>>;
  }
}

export function onesignalAppId() {
  return process.env.NEXT_PUBLIC_ONESIGNAL_APP_ID?.trim() || null;
}

// The official pattern: OneSignal's CDN script defines window.OneSignal asynchronously,
// so every call site pushes a callback onto OneSignalDeferred instead of touching
// window.OneSignal directly (which may not exist yet).
export function withOneSignal(callback: (OneSignal: OneSignalSdk) => void | Promise<void>) {
  if (typeof window === "undefined") return;
  window.OneSignalDeferred = window.OneSignalDeferred || [];
  window.OneSignalDeferred.push(callback);
}

export function detectDeviceType(): "desktop" | "mobile" | "unknown" {
  if (typeof navigator === "undefined") return "unknown";
  return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ? "mobile" : "desktop";
}

// Activates push for this browser. Must be called from a user gesture (button click) —
// browsers silently ignore or auto-block a permission request that fires without one.
//
// PushSubscription.optIn() (not Notifications.requestPermission()) is the correct call
// here: per OneSignal's docs, optIn() shows the native permission prompt itself when
// there's no valid push token yet, AND marks the subscription "subscribed" on OneSignal's
// side once granted. requestPermission() only resolves the BROWSER-level permission — it
// never flips OneSignal's own subscription status, so a user could show as
// Notification.permission === "granted" in their browser while OneSignal never creates a
// subscription at all (confirmed in production: browser permission "Allowed", zero rows
// in push_subscriptions). Do not swap this back to requestPermission() without solving
// that gap some other way.
export function requestOneSignalPermission(): Promise<void> {
  return new Promise((resolve, reject) => {
    withOneSignal(async (OneSignal) => {
      try {
        await OneSignal.User.PushSubscription.optIn();
        resolve();
      } catch (error) {
        reject(error instanceof Error ? error : new Error("Unable to enable push notifications."));
      }
    });
  });
}
