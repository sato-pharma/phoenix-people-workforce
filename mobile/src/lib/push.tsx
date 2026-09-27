import Constants, { ExecutionEnvironment } from "expo-constants";
import * as Device from "expo-device";
import { router } from "expo-router";
import * as SecureStore from "expo-secure-store";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Appearance, AppState } from "react-native";
import type {
  NotificationClickEvent,
  OneSignal as OneSignalNamespace,
  PushSubscriptionChangedState,
} from "react-native-onesignal";

import { apiGetData, apiRequest } from "./api";
import { apiBaseUrl } from "./config";
import { openPhoenixUrl } from "./portal/open-module";
import { resolvePushLink } from "./push-link";

/**
 * Push notifications on the phone.
 *
 * THE PHONE JOINS THE WEB'S ONESIGNAL APP; THE SERVER CHANGES NOTHING ABOUT HOW IT SENDS. Phoenix
 * already sends every push through OneSignal to an external ID — the employee's HR ID, uppercased —
 * and OneSignal delivers it to every device logged in as that ID. So this file does what
 * `src/components/notifications/onesignal-provider.tsx` does in a browser, and nothing more:
 *
 *   1. ask the server which OneSignal app to join and which HR ID this session is
 *      (`/api/notifications/push/context`), so there is one source of truth for both;
 *   2. `initialize` with that app and `login` as that HR ID;
 *   3. report this phone's subscription to `/api/notifications/push/register` whenever it changes,
 *      because the server only attempts a push for someone with a `subscribed` row there.
 *
 * NOT IN EXPO GO. OneSignal is native code, and its JS module fetches that code the moment it is
 * imported (`TurboModuleRegistry.getEnforcing`), which throws in Expo Go. So it is only ever
 * `require`d lazily, behind a check, and everything here degrades to "unavailable" without it. The
 * rest of the app keeps working in Expo Go exactly as before; notifications need an installed build.
 *
 * ENDING A SESSION. A deliberate sign-out logs OneSignal out, so the next person to use the phone
 * does not get this employee's notifications (`endPushSession`, called by `session.tsx`). An EXPIRED
 * session does not: sessions lapse every 12 hours, and a phone that stopped receiving notifications
 * twice a day would make them useless — the same employee is still holding it.
 *
 * LOCATION IS NEVER SHARED WITH ONESIGNAL. `app.json` builds OneSignal without its location module
 * (`disableLocation`), because this app holds location permission for evidence photos and the
 * OneSignal SDK otherwise collects location whenever an app has it.
 */

type OneSignalApi = typeof OneSignalNamespace;

/** The OneSignal app to join and who to join it as — `null` when the server has none. */
type PushContext = { appId?: string | null; hrId?: string | null };

export type PushStatus =
  /** Expo Go, or a build made without the OneSignal native module. */
  | "unavailable"
  /** Asking the server, or OneSignal, where things stand. */
  | "starting"
  /** Phoenix could not be reached. Tried again whenever the app comes back to the front. */
  | "unreachable"
  /** The server has no OneSignal app configured, so there is nothing to join. */
  | "not-set-up"
  /** This account has no employee record, so no notification is ever addressed to it. */
  | "no-employee"
  /** The phone has not allowed notifications. */
  | "off"
  | "on";

/** Where the OneSignal app ID is kept, so a sign-out in a fresh app launch can still log out. */
const APP_ID_KEY = "phoenix.push.app";

/**
 * Set once the system permission prompt has been shown on this install.
 *
 * The app asks by itself ONCE, and after that only when the person presses the button on Profile.
 * The owner's rule for the web nudge — a prompt asked more than once becomes wallpaper
 * (`src/lib/notifications/push-opt-in-nudge-rules.ts`) — holds here too, and Android enforces a
 * version of it anyway: a permission refused twice is never shown again.
 */
const ASKED_KEY = "phoenix.push.asked";

/** The register call is a background report — it must never hold up a screen or a sign-out. */
const REPORT_TIMEOUT_MS = 10_000;

let loadedSdk: OneSignalApi | null | undefined;

/** The OneSignal SDK, or null wherever it cannot run. Loaded on first use, never at import. */
function oneSignal(): OneSignalApi | null {
  if (loadedSdk !== undefined) return loadedSdk;
  loadedSdk = null;

  if (Constants.executionEnvironment === ExecutionEnvironment.StoreClient) return loadedSdk;

  try {
    const sdk = require("react-native-onesignal") as typeof import("react-native-onesignal");
    loadedSdk = sdk.OneSignal;
  } catch {
    // A development build made without the native module: the same answer as Expo Go.
    loadedSdk = null;
  }
  return loadedSdk;
}

/**
 * What `push_subscriptions.user_agent` records for this phone. It must keep starting with
 * "Phoenix Workforce app": Force logout finds this app's subscriptions by those words
 * (`isPhoenixAppPushSubscription` in the web app), because a phone browser's row is `mobile` too.
 */
function describeThisDevice(): string {
  const app = `Phoenix Workforce app ${Constants.expoConfig?.version ?? ""}`.trim();
  const model = [Device.manufacturer, Device.modelName].filter(Boolean).join(" ");
  const system = [Device.osName, Device.osVersion].filter(Boolean).join(" ");
  return [app, model, system].filter(Boolean).join(" · ").slice(0, 300);
}

/** Tell Phoenix whether this phone can be reached. Best-effort, like the browser's report. */
async function reportSubscription(
  token: string,
  subscriptionId: string | null | undefined,
  optedIn: boolean,
): Promise<void> {
  if (!subscriptionId) return;
  await apiRequest("/api/notifications/push/register", {
    body: {
      deviceType: "mobile",
      onesignalSubscriptionId: subscriptionId,
      optedIn,
      userAgent: describeThisDevice(),
    },
    method: "POST",
    timeoutMs: REPORT_TIMEOUT_MS,
    token,
  }).catch(() => undefined);
}

/** Show the system permission prompt, if it has never been shown on this install. */
async function askOnce(sdk: OneSignalApi): Promise<void> {
  try {
    if (await SecureStore.getItemAsync(ASKED_KEY)) return;
    if (!(await sdk.Notifications.canRequestPermission())) return;
    // Recorded BEFORE the prompt, so an app killed while it is on screen does not ask again.
    await SecureStore.setItemAsync(ASKED_KEY, new Date().toISOString());
    await sdk.Notifications.requestPermission(false);
  } catch {
    // The Profile screen's button is the way back from any failure here.
  }
}

/**
 * Take the person where a tapped notification points — see `push-link.ts` for the rules.
 *
 * `token` is the live session's, so a portal link opens through the signed-in hand-off rather than
 * relying on Chrome happening to be signed in. It used to depend on exactly that: a tapped approval
 * notification landed on the login page for anyone who had never signed into Phoenix in Chrome on
 * that handset, which is most of the fleet.
 */
function openNotificationLink(event: NotificationClickEvent, token: string | null): void {
  const target = resolvePushLink(event?.result?.url ?? event?.notification?.launchURL, apiBaseUrl);
  if (!target) return;

  if (target.kind === "screen") {
    router.navigate(target.href);
    return;
  }
  // A Custom Tab rather than leaving for Chrome: the person is one "close" away from the app.
  void openPhoenixUrl({ dark: Appearance.getColorScheme() === "dark", token, url: target.url });
}

/**
 * Stop this phone receiving the signed-out employee's notifications.
 *
 * Called by `signOut` BEFORE it revokes the token, because the report to Phoenix needs the token to
 * still be good. OneSignal is initialised first on purpose: after a fresh launch nothing may have
 * initialised it yet, its `logout` throws when called before `initialize`, and an employee logged in
 * natively from an earlier launch would otherwise stay logged in after signing out.
 */
export async function endPushSession(token: string | null): Promise<void> {
  const sdk = oneSignal();
  if (!sdk) return;

  let appId: string | null = null;
  try {
    appId = await SecureStore.getItemAsync(APP_ID_KEY);
  } catch {
    appId = null;
  }
  // No app ID on record means push never started on this install, so OneSignal holds no employee.
  if (!appId) return;

  try {
    sdk.initialize(appId);
    const subscriptionId = await sdk.User.pushSubscription.getIdAsync().catch(() => null);
    sdk.logout();
    if (token) await reportSubscription(token, subscriptionId, false);
  } catch {
    // Signing out must not fail in the person's face. What a failure here leaves behind is bounded:
    // the next `login` on this phone moves the subscription to whoever signs in, and a Phoenix row
    // still saying `subscribed` costs one send that OneSignal answers "not subscribed", which the
    // server records as a skipped delivery.
  }
}

type PushContextValue = {
  /** Ask for notification permission — or, when it was refused for good, offer the phone's settings. */
  enable: () => Promise<void>;
  status: PushStatus;
};

const PushContextReact = createContext<PushContextValue | null>(null);

/**
 * Starts push for the signed-in employee and keeps Phoenix told about this phone.
 *
 * Mounted by the portal layout, so it runs only while someone is signed in and re-runs for each new
 * session token. Renders nothing of its own.
 */
export function PushProvider({ children, token }: { children: ReactNode; token: string | null }) {
  const [status, setStatus] = useState<PushStatus>(() => (oneSignal() ? "starting" : "unavailable"));
  // Bumped to retry after Phoenix could not be reached.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const sdk = oneSignal();
    if (!sdk || !token) return;

    let cancelled = false;
    const cleanups: Array<() => void> = [];

    const start = async () => {
      let context: PushContext | null;
      try {
        context = await apiGetData<PushContext>("/api/notifications/push/context", token);
      } catch {
        if (!cancelled) setStatus("unreachable");
        return;
      }
      if (cancelled) return;

      const appId = typeof context?.appId === "string" ? context.appId.trim() : "";
      const hrId = typeof context?.hrId === "string" ? context.hrId.trim() : "";
      if (!appId) {
        setStatus("not-set-up");
        return;
      }
      if (!hrId) {
        setStatus("no-employee");
        return;
      }

      await SecureStore.setItemAsync(APP_ID_KEY, appId).catch(() => undefined);
      if (cancelled) return;

      // Order matters: OneSignal refuses `login` before `initialize`. Both are idempotent, so a retry
      // or a re-render re-running them is harmless.
      sdk.initialize(appId);
      sdk.login(hrId);

      // A tap that launched the app is held by OneSignal until a click listener exists, so adding it
      // here still catches the notification that opened the app.
      // Bound to THIS session's token, and removed by the same reference — a module-level handler
      // could not reach the token at all, which is why the portal hand-off lives behind a closure.
      const onClick = (event: NotificationClickEvent) => openNotificationLink(event, token);
      sdk.Notifications.addEventListener("click", onClick);
      cleanups.push(() => sdk.Notifications.removeEventListener("click", onClick));

      const onPermission = (granted: boolean) => {
        if (!cancelled) setStatus(granted ? "on" : "off");
      };
      sdk.Notifications.addEventListener("permissionChange", onPermission);
      cleanups.push(() => sdk.Notifications.removeEventListener("permissionChange", onPermission));

      const onSubscription = (change: PushSubscriptionChangedState) => {
        void reportSubscription(token, change.current.id, change.current.optedIn);
      };
      sdk.User.pushSubscription.addEventListener("change", onSubscription);
      cleanups.push(() => sdk.User.pushSubscription.removeEventListener("change", onSubscription));

      // A phone that was already subscribed may not see a fresh change this launch, so its current
      // state is reported once as well — the browser provider does the same.
      const [subscriptionId, optedIn] = await Promise.all([
        sdk.User.pushSubscription.getIdAsync().catch(() => null),
        sdk.User.pushSubscription.getOptedInAsync().catch(() => false),
      ]);
      if (cancelled) return;
      void reportSubscription(token, subscriptionId, optedIn);

      const granted = await sdk.Notifications.getPermissionAsync().catch(() => false);
      if (cancelled) return;
      setStatus(granted ? "on" : "off");
      if (!granted) await askOnce(sdk);
    };

    void start();

    return () => {
      cancelled = true;
      for (const cleanup of cleanups) cleanup();
    };
  }, [attempt, token]);

  useEffect(() => {
    if (status !== "unreachable") return;
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") {
        setStatus("starting");
        setAttempt((count) => count + 1);
      }
    });
    return () => subscription.remove();
  }, [status]);

  const enable = useCallback(async () => {
    const sdk = oneSignal();
    if (!sdk) return;
    try {
      // `true`: when the permission was refused for good, OneSignal offers the phone's settings
      // instead of a prompt Android would no longer show.
      const granted = await sdk.Notifications.requestPermission(true);
      setStatus(granted ? "on" : "off");
    } catch {
      // The permission listener still reports whatever the person chose.
    }
  }, []);

  const value = useMemo<PushContextValue>(() => ({ enable, status }), [enable, status]);

  return <PushContextReact.Provider value={value}>{children}</PushContextReact.Provider>;
}

export function usePush(): PushContextValue {
  const context = useContext(PushContextReact);
  if (!context) {
    throw new Error("usePush must be used inside <PushProvider>.");
  }
  return context;
}

/** One sentence for the Profile screen saying where notifications stand on this phone. */
export function describePushStatus(status: PushStatus): string {
  switch (status) {
    case "on":
      return "On. Phoenix can send notifications to this phone.";
    case "off":
      return "Off. Turn them on to get approvals, requests and reminders on this phone.";
    case "starting":
      return "Checking whether this phone can receive notifications.";
    case "unreachable":
      return "Phoenix could not be reached to set up notifications. The app tries again the next time you open it.";
    case "not-set-up":
      return "Phoenix is not sending notifications to phones yet.";
    case "no-employee":
      return "This account has no employee record, so no notifications are addressed to it.";
    case "unavailable":
      return Constants.executionEnvironment === ExecutionEnvironment.StoreClient
        ? "Expo Go cannot receive notifications. The installed app can."
        : "This build of the app was made without notifications.";
  }
}
