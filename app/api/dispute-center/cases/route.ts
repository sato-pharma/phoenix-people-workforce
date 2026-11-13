import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { ApiError } from "@/lib/http/api-errors";
import { listCalendarCases } from "@/lib/dispute-center/calendar.ts";
import { listDailyCases } from "@/lib/dispute-center/daily.ts";
import { listDeductionCases } from "@/lib/dispute-center/deduction.ts";
import { listDigestCases } from "@/lib/dispute-center/digest.ts";
import { disputeCenterError } from "@/lib/dispute-center/http.ts";
import { DISPUTE_CASE_KINDS, isDisputeCaseKind, type DisputeCase } from "@/lib/dispute-center/types.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// EVERY dispute the caller may see, from one, two or all three modules — open, waiting and decided
// alike (owner, 2026-10-09: "dispute closed dispute open but never disappeared from me or the
// employee side"). Each adapter applies its own module's audience rule: a reviewer sees the
// company's, anybody else sees their own, and a role in neither gets an empty list rather than an
// error, so one failing module never blanks the screen.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    // Before anything is read, and before the per-module fan-out below, whose catch would
    // otherwise turn a refusal into "that module is unavailable" and answer 200.
    await assertPermission(access, "attendance", "read");
    const url = new URL(request.url);
    const requested = url.searchParams.getAll("kind").filter(isDisputeCaseKind);
    const kinds = requested.length > 0 ? requested : DISPUTE_CASE_KINDS;

    const unavailable: string[] = [];
    const settled = await Promise.all(
      kinds.map(async (kind) => {
        try {
          if (kind === "calendar") return await listCalendarCases(access);
          if (kind === "deduction") return await listDeductionCases(access);
          if (kind === "daily") return await listDailyCases(access);
          return await listDigestCases(access);
        } catch (error) {
          // One module that cannot be read must not hide the other two — but it is NAMED, never
          // silently dropped, or a reader takes a short list for a quiet week. An ACCESS error is
          // not that: a refusal has to leave as a refusal, not as a quiet gap in the list.
          if (error instanceof ApiError) throw error;
          unavailable.push(kind);
          void error;
          return [] as DisputeCase[];
        }
      }),
    );

    const cases = settled.flat().sort((left, right) => String(right.lastActivityAt).localeCompare(String(left.lastActivityAt)));
    return NextResponse.json({ cases, success: true, unavailable });
  } catch (error) {
    return disputeCenterError(error, "Unable to load the disputes.");
  }
}
