"use client";

import { useEffect, useRef } from "react";

import {
  clearSessionActivity,
  markSessionInvalidated,
  phoenixSessionTimeoutReason,
} from "@/lib/auth/client-session";
import { hardNavigate } from "@/lib/navigation/browser-navigation";
import { logoutOneSignal } from "@/lib/notifications/onesignal-client";
import { notePulseActivity, subscribePulseSessionEnded } from "@/lib/session-pulse-store";

// No client-side inactivity clock (owner decision 2026-07-23): a session used to be
// force-logged-out after 15 minutes of no clicks/keys/scrolls on this tab, purely on a
// local timer — which meant opening a push notification (or anything else) more than
// 15 minutes after last touching the app landed on /login even though the server-side
// session was still fine. The heartbeat below remains the real source of truth: it
// reports to the server on activity/resume, and a 401 response (session actually
// revoked, absolute-expired, or role changed) is still an authoritative, immediate
// logout — that check is unaffected by this change.
//
// The heartbeat is a POST on the session pulse (src/lib/session-pulse-store.ts), the one request an
// open tab sends for the sidebar badges, the notification bell and this keep-alive together. This
// component only reports activity to it and acts on a 401 — the 60 s floor between heartbeats, the
// in-flight guard and the tab-visibility rules all live in the store.
export function SessionSecurityGuard() {
  const loggingOutRef = useRef(false);

  useEffect(() => {
    const unsubscribe = subscribePulseSessionEnded(() => {
      markSessionInvalidated("heartbeat_401");
      if (!loggingOutRef.current) {
        loggingOutRef.current = true;
        logoutOneSignal();
        clearSessionActivity();
        hardNavigate(`/login?reason=${phoenixSessionTimeoutReason}`);
      }
    });

    const reportActivity = () => notePulseActivity();
    reportActivity();

    const activityEvents: Array<keyof WindowEventMap> = [
      "click",
      "keydown",
      "mousemove",
      "scroll",
      "touchstart",
    ];
    activityEvents.forEach((eventName) => {
      window.addEventListener(eventName, reportActivity, { passive: true });
    });
    window.addEventListener("focus", reportActivity);
    document.addEventListener("visibilitychange", reportActivity);

    return () => {
      unsubscribe();
      activityEvents.forEach((eventName) => {
        window.removeEventListener(eventName, reportActivity);
      });
      window.removeEventListener("focus", reportActivity);
      document.removeEventListener("visibilitychange", reportActivity);
    };
  }, []);

  return null;
}
