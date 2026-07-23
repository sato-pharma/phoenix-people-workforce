"use client";

import { useEffect, useRef } from "react";

import {
  clearSessionActivity,
  markSessionActivity,
  markSessionInvalidated,
  phoenixSessionTimeoutReason,
  readSessionActivityAt,
} from "@/lib/auth/client-session";
import { logoutOneSignal } from "@/lib/notifications/onesignal-client";

async function logoutForTimeout() {
  markSessionInvalidated("client_idle_timeout");
  // Unbind this browser from OneSignal's identity for the same reason a manual logout
  // does — an idle-timeout logout is still a real sign-out.
  logoutOneSignal();
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } catch {
    // Redirect even if the logout request fails; expired cookies will be cleared on next login.
  } finally {
    clearSessionActivity();
    window.location.assign(`/login?reason=${phoenixSessionTimeoutReason}`);
  }
}

export function SessionSecurityGuard({
  idleTimeoutMs = 15 * 60 * 1000,
}: {
  idleTimeoutMs?: number;
}) {
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
        // Keep client-side timeout enforcement active when the heartbeat is temporarily unavailable.
      }
    };

    const markActivity = () => {
      markSessionActivity();
    };

    const enforceTimeout = () => {
      if (loggingOutRef.current) return;

      const lastActivity = readSessionActivityAt();
      if (!lastActivity) {
        markActivity();
        return;
      }

      if (Date.now() - lastActivity >= idleTimeoutMs) {
        loggingOutRef.current = true;
        void logoutForTimeout();
      }
    };

    const handleUserActivity = () => {
      enforceTimeout();
      if (!loggingOutRef.current) {
        markActivity();
        void sendHeartbeat();
      }
    };

    const handleResume = () => {
      enforceTimeout();
      if (!loggingOutRef.current) {
        void sendHeartbeat();
      }
    };

    if (readSessionActivityAt()) {
      enforceTimeout();
    } else {
      markActivity();
    }
    void sendHeartbeat();

    const activityEvents: Array<keyof WindowEventMap> = [
      "click",
      "keydown",
      "mousemove",
      "scroll",
      "touchstart",
    ];
    activityEvents.forEach((eventName) => {
      window.addEventListener(eventName, handleUserActivity, { passive: true });
    });
    window.addEventListener("focus", handleResume);
    document.addEventListener("visibilitychange", handleResume);

    const interval = window.setInterval(enforceTimeout, 60 * 1000);

    return () => {
      activityEvents.forEach((eventName) => {
        window.removeEventListener(eventName, handleUserActivity);
      });
      window.removeEventListener("focus", handleResume);
      document.removeEventListener("visibilitychange", handleResume);
      window.clearInterval(interval);
    };
  }, [idleTimeoutMs]);

  return null;
}
