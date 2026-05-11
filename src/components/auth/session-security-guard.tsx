"use client";

import { useEffect, useRef } from "react";

const lastActivityKey = "phoenix_last_activity_at";
const timeoutReason = "session-timeout";

async function logoutForTimeout() {
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } catch {
    // Redirect even if the logout request fails; expired cookies will be cleared on next login.
  } finally {
    window.localStorage.removeItem(lastActivityKey);
    window.location.assign(`/login?reason=${timeoutReason}`);
  }
}

function readLastActivity() {
  const parsed = Number(window.localStorage.getItem(lastActivityKey));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
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
        if (response.status === 401 && !loggingOutRef.current) {
          loggingOutRef.current = true;
          window.localStorage.removeItem(lastActivityKey);
          window.location.assign(`/login?reason=${timeoutReason}`);
        }
      } catch {
        // Keep client-side timeout enforcement active when the heartbeat is temporarily unavailable.
      }
    };

    const markActivity = () => {
      window.localStorage.setItem(lastActivityKey, String(Date.now()));
    };

    const enforceTimeout = () => {
      if (loggingOutRef.current) return;

      const lastActivity = readLastActivity();
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

    if (readLastActivity()) {
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
