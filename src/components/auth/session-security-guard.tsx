"use client";

import { useEffect, useRef } from "react";

import {
  clearSessionActivity,
  markSessionInvalidated,
  phoenixSessionTimeoutReason,
} from "@/lib/auth/client-session";
import { logoutOneSignal } from "@/lib/notifications/onesignal-client";

// No client-side inactivity clock (owner decision 2026-07-23): a session used to be
// force-logged-out after 15 minutes of no clicks/keys/scrolls on this tab, purely on a
// local timer — which meant opening a push notification (or anything else) more than
// 15 minutes after last touching the app landed on /login even though the server-side
// session was still fine. The heartbeat below remains the real source of truth: it
// reports to the server on activity/resume, and a 401 response (session actually
// revoked, absolute-expired, or role changed) is still an authoritative, immediate
// logout — that check is unaffected by this change.
export function SessionSecurityGuard() {
  const loggingOutRef = useRef(false);
  const lastHeartbeatRef = useRef(0);

  useEffect(() => {
    const sendHeartbeat = async () => {
      const now = Date.now();
      if (now - lastHeartbeatRef.current < 60 * 1000) return;
      lastHeartbeatRef.current = now;

      try {
        const response = await fetch("/api/auth/heartbeat", { method: "POST" });
        if (response.status === 401) {
          markSessionInvalidated("heartbeat_401");
          if (!loggingOutRef.current) {
            loggingOutRef.current = true;
            logoutOneSignal();
            clearSessionActivity();
            window.location.assign(`/login?reason=${phoenixSessionTimeoutReason}`);
          }
        }
      } catch {
        // Transient network hiccup — the next activity/resume event will retry.
      }
    };

    void sendHeartbeat();

    const activityEvents: Array<keyof WindowEventMap> = [
      "click",
      "keydown",
      "mousemove",
      "scroll",
      "touchstart",
    ];
    activityEvents.forEach((eventName) => {
      window.addEventListener(eventName, sendHeartbeat, { passive: true });
    });
    window.addEventListener("focus", sendHeartbeat);
    document.addEventListener("visibilitychange", sendHeartbeat);

    return () => {
      activityEvents.forEach((eventName) => {
        window.removeEventListener(eventName, sendHeartbeat);
      });
      window.removeEventListener("focus", sendHeartbeat);
      document.removeEventListener("visibilitychange", sendHeartbeat);
    };
  }, []);

  return null;
}
