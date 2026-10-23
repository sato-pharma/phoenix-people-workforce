"use client";

import { useEffect } from "react";

import type { PhoenixCrmModuleKey } from "@/lib/phoenix-crm/modules";

/**
 * Tells the server the viewer has the module on his screen, so its "new" badge clears for next time.
 *
 * It is a CLIENT effect on purpose and never a server-render side effect: the chooser's cards prefetch
 * the module page while they are on screen, and a prefetch renders on the server without anyone
 * looking at it — marking read there would clear a badge nobody had seen. An effect runs
 * only once the page is really mounted. It renders nothing, and a failure is swallowed: the worst case
 * is a badge that clears one visit later.
 */
export function PhoenixCrmNoticesSeen({ moduleKey, pending }: { moduleKey: PhoenixCrmModuleKey; pending: boolean }) {
  useEffect(() => {
    if (!pending) return;
    void fetch("/api/phoenix-crm/notices/seen", {
      body: JSON.stringify({ module: moduleKey }),
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      keepalive: true,
      method: "POST",
    }).catch(() => undefined);
  }, [moduleKey, pending]);
  return null;
}
