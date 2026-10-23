import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { emptyBadgeCounts, loadBadgeCounts } from "@/lib/approvals-hub/badge-counts-payload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The batched sidebar badge counts. The eleven domain reads, their permission guards and the
 * twenty-second per-viewer memory live in `loadBadgeCounts` (badge-counts-payload.ts) so that
 * /api/auth/pulse — the folded poll that carries the session heartbeat, the badges and the notices
 * in one request — serves the same counts from the same code and the same memory.
 *
 * This path stays for every other consumer and is unchanged in what it answers: the same body, the
 * same `{count: 0}` fallbacks, the same three timing names.
 */
export async function GET(request: Request) {
  const startedAt = Date.now();
  try {
    const access = await resolveAccessContext(request);
    return NextResponse.json(await loadBadgeCounts(access, startedAt), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json(emptyBadgeCounts());
  }
}
