import { NextResponse } from "next/server";
import { z } from "zod";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext, jsonError } from "@/lib/deductions/http.ts";
import { parseJsonBody } from "@/lib/http/request-body";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { assertDailyDeductionsPublishActor } from "@/lib/daily-deductions/permissions.ts";
import { runConnectorForRange } from "@/lib/daily-deductions/service.ts";
import { cairoTodayIso } from "@/lib/daily-deductions/range.ts";
import { dailyDeductionConnectors, isDailyDeductionConnector } from "@/lib/daily-deductions/types.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// One connector per request — same 300s discipline as the month module's collect
// route (#1377): a company-wide scan over a multi-month range is the heavy path.
export const maxDuration = 300;

/**
 * The Daily Deductions screen sends `{ connector, from, to }` — one connector key and the picked
 * range (YYYY-MM-DD). No connector (or an empty body) asks for the plan. Which connector, and that the
 * range is there, is still checked below with the route's own words.
 */
const ComputeBodySchema = z.object({
  connector: z.string().nullish(),
  from: z.string().nullish(),
  to: z.string().nullish(),
});

/**
 * Runs ONE connector over a picked range and returns the clipped running tally.
 * Read-only: the connectors return findings; nothing is written until the owner
 * publishes. A request with no `connector` returns the connector plan.
 */
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "deductions", "create");
    assertDailyDeductionsPublishActor(access);

    const parsed = await parseJsonBody(request, ComputeBodySchema, { fallback: {} });
    if (!parsed.ok) {
      return NextResponse.json({ success: false, error: parsed.message }, { status: 400 });
    }
    const body = parsed.data;

    const plan = dailyDeductionConnectors.map((connector) => ({ key: connector }));
    if (body.connector === undefined || body.connector === null) {
      return NextResponse.json({ success: true, plan });
    }
    if (!isDailyDeductionConnector(body.connector)) {
      throw new Error(`Validation: connector must be one of ${dailyDeductionConnectors.join(", ")}.`);
    }
    if (typeof body.from !== "string" || typeof body.to !== "string") {
      throw new Error("Validation: from and to are required (YYYY-MM-DD).");
    }

    const tally = await runConnectorForRange({
      connector: body.connector,
      range: { from: body.from, to: body.to },
      todayIso: cairoTodayIso(),
    });

    return NextResponse.json({ success: true, connector: body.connector, tally });
  } catch (error) {
    return jsonError(error, "Failed to compute the daily deductions tally.");
  }
}
