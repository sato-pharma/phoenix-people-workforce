import { NextResponse } from "next/server";

import {
  PAGE_TIMING_MAX_BODY_BYTES,
  PAGE_TIMING_RATE_LIMIT,
  PAGE_TIMING_RATE_WINDOW_MS,
  admitPageTimingName,
  sanitizePageTiming,
} from "@/lib/observability/page-timing-intake";
import { recordTiming } from "@/lib/observability/timings";
import { clientAddress } from "@/lib/security/client-address";
import { createMemoryRateBuckets } from "@/lib/security/memory-rate-buckets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Browser timing beacon (performance roadmap, phase 3). A page that has painted tells the server how long
// the first content and the largest content took, and the numbers go into the per-minute process_health
// log line beside the server timings (p50 / p95 / max per page shape). It stores NOTHING in the database,
// reads no session and records no identity: the only things kept are a page SHAPE (ids replaced by :id)
// and two durations — see page-timing-intake.ts.
//
// Abuse is bounded in process, not in the database, so a beacon never costs a query: a body over 1 KB is
// refused, one address gets PAGE_TIMING_RATE_LIMIT beacons a minute, and at most PAGE_TIMING_MAX_NAMES
// distinct page shapes are ever recorded. The answer is an empty 204 — the page does not wait on it.
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
    const report = sanitizePageTiming(JSON.parse(raw));
    if (report && admitPageTimingName(knownNames, report.path)) {
      if (report.firstContentMs !== null) recordTiming(`page_first_content ${report.path}`, report.firstContentMs);
      if (report.largestContentMs !== null) recordTiming(`page_largest_content ${report.path}`, report.largestContentMs);
    }
  } catch {
    // A malformed beacon is dropped; the page never needs to know.
  }
  return new NextResponse(null, { status: 204 });
}
