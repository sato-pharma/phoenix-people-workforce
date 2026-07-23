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

// Triggers the native browser permission prompt. Must be called from a user gesture
// (button click) — browsers silently ignore or auto-block a permission request that
// fires without one.
export function requestOneSignalPermission(): Promise<void> {
  return new Promise((resolve, reject) => {
    withOneSignal(async (OneSignal) => {
      try {
        await OneSignal.Notifications.requestPermission();
        resolve();
      } catch (error) {
        reject(error instanceof Error ? error : new Error("Unable to request push permission."));
      }
    });
  });
}
