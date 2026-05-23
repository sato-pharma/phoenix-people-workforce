import { NextResponse } from "next/server";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";

import { resolveAccessContext } from "@/lib/auth/server";
import { listInAppNotificationsForViewer } from "@/lib/notifications/in-app";
import { mergePendingApprovalNotifications } from "@/lib/pending-approvals/notifications";
import { listPendingApprovals } from "@/lib/pending-approvals/service";

export const runtime = "nodejs";

type ServerTimingMetric = {
  desc: string;
  name: string;
  durationMs: number;
};

function setServerTimingHeaders(
  headers: Headers,
  metrics: ServerTimingMetric[],
  totalMs: number,
) {
  for (const metric of metrics) {
    if (!Number.isFinite(metric.durationMs) || metric.durationMs < 0) {
      continue;
    }
    headers.append(
      "Server-Timing",
      `${metric.name};dur=${metric.durationMs.toFixed(0)};desc="${metric.desc}"`,
    );
  }

  if (Number.isFinite(totalMs) && totalMs >= 0) {
    headers.append(`Server-Timing`, `total;dur=${totalMs.toFixed(0)};desc="request"`);
  }
}

export async function GET(request: Request) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  const startedAt = performance.now();
  const trace: Record<string, number> = {};

  try {
    const authStartedAt = performance.now();
    const access = await resolveAccessContext(request);
    trace.authMs = performance.now() - authStartedAt;

    if (!access.loginId && !access.hrId) {
      const response = NextResponse.json({ data: [], readCount: 0, success: true, unreadCount: 0 });
      const totalMs = performance.now() - startedAt;
      const responseHeaders = response.headers;
      setServerTimingHeaders(
        responseHeaders,
        [{ desc: "resolve-access-context", name: "auth", durationMs: trace.authMs }],
        totalMs,
      );
      responseHeaders.set("X-Request-Id", requestId);
      return response;
    }

    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit") ?? 8);
    const requestedLimit = Number.isFinite(limit) ? limit : 8;

    const notificationsStartedAt = performance.now();
    const [storedNotifications, pendingApprovalItems] = await Promise.all([
      listInAppNotificationsForViewer(access, requestedLimit),
      listPendingApprovals(access).catch(() => []),
    ]);
    trace.notificationsFetchMs = performance.now() - notificationsStartedAt;

    const mergeStartedAt = performance.now();
    const notifications = mergePendingApprovalNotifications(storedNotifications, pendingApprovalItems, requestedLimit);
    trace.mergeMs = performance.now() - mergeStartedAt;
    const totalMs = performance.now() - startedAt;

    {
      const response = NextResponse.json({
      data: notifications,
      readCount: notifications.filter((notification) => notification.isRead).length,
      success: true,
      unreadCount: notifications.filter((notification) => !notification.isRead).length,
      });
      const responseHeaders = response.headers;
      setServerTimingHeaders(
        responseHeaders,
        [
          { desc: "resolve-access-context", name: "auth", durationMs: trace.authMs },
          {
            desc: "fetch-stored-and-pending-notifications",
            name: "notifications-fetch",
            durationMs: trace.notificationsFetchMs,
          },
          { desc: "merge-notifications", name: "merge", durationMs: trace.mergeMs },
        ],
        totalMs,
      );
      responseHeaders.set("Cache-Control", "private, max-age=60, stale-while-revalidate=240");
      responseHeaders.set("X-Request-Id", requestId);
      return response;
    }
  } catch (error) {
    const totalMs = performance.now() - startedAt;
    const message = error instanceof Error ? error.message : "Unable to load notifications.";
    const response = NextResponse.json({ error: "notification_load_failed", message }, { status: 500 });
    const responseHeaders = response.headers;
    responseHeaders.set("X-Request-Id", requestId);
    setServerTimingHeaders(
      responseHeaders,
      [
        { desc: "resolve-access-context", name: "auth", durationMs: trace.authMs },
        {
          desc: "fetch-stored-and-pending-notifications",
          name: "notifications-fetch",
          durationMs: trace.notificationsFetchMs,
        },
        { desc: "merge-notifications", name: "merge", durationMs: trace.mergeMs },
      ],
      totalMs,
    );
    return response;
  }
}
