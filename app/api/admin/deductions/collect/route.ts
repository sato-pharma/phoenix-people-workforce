import { NextResponse } from "next/server";
import { z } from "zod";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext, jsonError } from "@/lib/deductions/http.ts";
import {
  DEDUCTION_COLLECTORS,
  collectOneConnectorForMonth,
  isDeductionCollectorKey,
} from "@/lib/deductions/collect.ts";
import { isDeductionCycle } from "@/lib/deductions/cycle.ts";
import { assertDeductionsDecisionActor } from "@/lib/deductions/permissions.ts";
import { parseJsonBody } from "@/lib/http/request-body";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** A month or year as the route has always taken it: a number, or text it reads with Number(). */
const NumberLike = z.union([z.number(), z.string()]).nullish();

/**
 * The Deductions workspace sends `{ month, year }` for the plan, then `{ month, year, connector, cycle }`
 * once per connector — month and year as numbers. Ranges, the connector key and the cycle are still
 * checked below with the route's own words.
 */
const CollectBodySchema = z.object({
  month: NumberLike,
  year: NumberLike,
  connector: z.string().nullish(),
  /** "office" (the Head Office 22nd → 21st cycle, one-part pay) or "calendar" (the default). */
  cycle: z.string().nullish(),
});

/**
 * Runs ONE connector per request.
 *
 * The first cut of this endpoint ran all five company-wide scans sequentially in
 * a single request; on production-sized data that took longer than the 300s
 * Cloud Run limit, returned 504, and got the whole module reverted (#1377).
 * The client now drives the connectors one at a time, so no single request
 * carries more than a fifth of the work and a slow connector is an isolated,
 * named failure instead of a dead run.
 *
 * A request with no `connector` returns the plan rather than running anything —
 * that keeps the old all-in-one path structurally unreachable from HTTP.
 */
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "deductions", "create");
    assertDeductionsDecisionActor(access);

    const parsed = await parseJsonBody(request, CollectBodySchema, { fallback: {} });
    if (!parsed.ok) {
      return NextResponse.json({ success: false, error: parsed.message }, { status: 400 });
    }
    const body = parsed.data;
    const month = Number(body.month);
    const year = Number(body.year);
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new Error("Validation: month must be an integer between 1 and 12.");
    }
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new Error("Validation: year must be an integer between 2000 and 2100.");
    }

    // Absent means the calendar month — every caller before the two cycles keeps its meaning. Anything
    // else that is not a known cycle is refused rather than quietly run as the calendar month.
    const cycle = body.cycle === undefined || body.cycle === null ? "calendar" : body.cycle;
    if (!isDeductionCycle(cycle)) {
      throw new Error('Validation: cycle must be "office" or "calendar".');
    }

    const plan = DEDUCTION_COLLECTORS.map((collector) => ({ key: collector.key, label: collector.label }));

    if (body.connector === undefined || body.connector === null) {
      return NextResponse.json({ success: true, plan });
    }
    if (!isDeductionCollectorKey(body.connector)) {
      throw new Error(`Validation: connector must be one of ${plan.map((entry) => entry.key).join(", ")}.`);
    }

    const result = await collectOneConnectorForMonth({
      connector: body.connector,
      cycle,
      month,
      year,
      createdBy: access.hrId ?? access.loginId ?? "unknown",
    });

    return NextResponse.json({ success: true, connector: body.connector, cycle, result });
  } catch (error) {
    return jsonError(error, "Failed to run the monthly deductions collection.");
  }
}
