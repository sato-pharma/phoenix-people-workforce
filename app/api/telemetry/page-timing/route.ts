import { NextResponse } from "next/server";

import {
  PAGE_TIMING_MAX_BODY_BYTES,
  PAGE_TIMING_RATE_LIMIT,
  PAGE_TIMING_RATE_WINDOW_MS,
  admitPageTimingName,
  sanitizePageTimings,
} from "@/lib/observability/page-timing-intake";
import { recordPageTiming } from "@/lib/observability/page-timing-store";
import { recordTiming } from "@/lib/observability/timings";
import { clientAddress } from "@/lib/security/client-address";
import { createMemoryRateBuckets } from "@/lib/security/memory-rate-buckets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Browser timing beacon (performance roadmap, phase 3; widened 1 Nov 2026). A page that has painted
// tells the server how long its hard load took (first byte, first content, largest content, interactive,
// first /api/ answer), and each tap inside the app how long it took to reach its page. The numbers go
// into the per-minute process_health log line (p50 / p95 / max per page shape) AND into the hour's
// in-process summary, which the process-health tick writes to the page_timings table once the hour has
// ended. This route itself touches no database, reads no session and records no identity: what is kept
// is a page SHAPE (ids replaced by :id), a kind, a device class and durations — see page-timing-intake.ts.
//
// Abuse is bounded in process, so a beacon never costs a query: a body over 1 KB is refused, one address
// gets PAGE_TIMING_RATE_LIMIT beacons a minute, and at most PAGE_TIMING_MAX_NAMES distinct page shapes
// are ever recorded. The answer is an empty 204 — the page does not wait on it.
const knownNames = new Set<string>();

// At most this many addresses are counted at once. A FULL map makes room by dropping the oldest
// window (memory-rate-buckets.ts) — it used to refuse every caller instead, so 5,000 rotating
// addresses switched the beacon off for everybody until the next restart (audit, 2026-10-26, point 23).
const PAGE_TIMING_MAX_ADDRESSES = 5_000;
const addressBuckets = createMemoryRateBuckets(PAGE_TIMING_MAX_ADDRESSES);

function withinRateLimit(address: string): boolean {
  return addressBuckets.consume(address, PAGE_TIMING_RATE_LIMIT, PAGE_TIMING_RATE_WINDOW_MS) === 0;
}

export async function POST(request: Request) {
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > PAGE_TIMING_MAX_BODY_BYTES) {
    return new NextResponse(null, { status: 413 });
  }
  if (!withinRateLimit(clientAddress(request) || "unknown-ip")) {
    return new NextResponse(null, { status: 429 });
  }
  try {
    const raw = await request.text();
    if (raw.length > PAGE_TIMING_MAX_BODY_BYTES) return new NextResponse(null, { status: 413 });
    for (const report of sanitizePageTimings(JSON.parse(raw))) {
      if (!admitPageTimingName(knownNames, report.path)) continue;
      recordPageTiming(report);
      for (const [metric, ms] of Object.entries(report.metrics)) recordTiming(`page_${metric} ${report.path}`, ms);
    }
  } catch {
    // A malformed beacon is dropped; the page never needs to know.
  }
  return new NextResponse(null, { status: 204 });
}
