import { NextResponse } from "next/server";

import { runWideIReports360Reconciliation } from "@/lib/visits-report/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 300s is the highest maxDuration already proven safe on this Vercel plan (see
// app/api/sales/sales-upload/commit/route.ts). Even so, a full 120-day reconciliation
// (fetch + upsert + delete-reconciliation + check-in reconciliation + FWC snapshot refresh)
// may still exceed this under heavy CRM load - see the 2026-07-06 investigation note in
// runWideIReports360Reconciliation's doc comment for the follow-up if this keeps timing out.
export const maxDuration = 300;

function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  // Every Vercel environment (production, preview, `vercel dev`) sets VERCEL — only a
  // real local machine without it may bypass an unset CRON_SECRET during development.
  if (!secret) return !process.env.VERCEL && process.env.NODE_ENV === "development";
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

async function runReconcile() {
  const result = await runWideIReports360Reconciliation();
  // No probation DV-tick call here on purpose — the daily ireports360-visits-sync cron already
  // covers that over its own (narrower) window; re-running it over this wide window would be
  // redundant extra load with no benefit.
  return NextResponse.json({ success: true, ...result });
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "unauthorized", message: "iReports360 wide reconciliation is not authorized." }, { status: 401 });
  }
  try {
    return await runReconcile();
  } catch (error) {
    console.error(error, { tags: { cron: "ireports360-visits-reconcile" } });
    const message = error instanceof Error ? error.message : "iReports360 wide reconciliation failed.";
    return NextResponse.json({ error: "ireports360_visits_reconcile_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
