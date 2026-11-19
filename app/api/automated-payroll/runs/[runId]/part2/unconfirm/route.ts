import { NextResponse } from "next/server";
import { z } from "zod";

import { jsonError, resolveAccessContext } from "@/lib/automated-payroll/http";
import { assertAutomatedPayrollHrActor } from "@/lib/automated-payroll/permissions";
import { unconfirmPart2 } from "@/lib/automated-payroll/run-service";
import { assertSignedIn } from "@/lib/auth/require-signed-in";
import { parseJsonBody } from "@/lib/http/request-body";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * No body, `{}`, or the override `{ overrideDownloaded: true, reason }` the wizard sends after a
 * bank-file refusal (REC-060). Only an explicit `true` overrides; the service judges the reason.
 */
const UnconfirmPart2BodySchema = z
  .object({
    overrideDownloaded: z.boolean().optional(),
    reason: z.string().nullable().optional(),
  })
  .nullable();

/**
 * Body (optional): `{ "overrideDownloaded": true, "reason": "<why>" }` — reopen Part 2 of a run whose
 * bank files finance has already downloaded. Without it such a reopen is refused (409); see
 * src/lib/automated-payroll/bank-file-downloads.ts (REC-035).
 */
export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const { runId } = await params;
    const access = await resolveAccessContext(request);
    assertSignedIn(access);
    // REC-080: the service's own gate, asked before the body is judged.
    assertAutomatedPayrollHrActor(access);
    const parsed = await parseJsonBody(request, UnconfirmPart2BodySchema, { fallback: null });
    if (!parsed.ok) return jsonError(new Error(`Validation: ${parsed.message}`));
    const body = parsed.data;
    const run = await unconfirmPart2(access, runId, {
      overrideDownloaded:
        body?.overrideDownloaded === true ? { reason: typeof body.reason === "string" ? body.reason : null } : null,
    });
    return NextResponse.json({ success: true, run });
  } catch (error) {
    return jsonError(error, "Failed to unconfirm Part 2.");
  }
}
