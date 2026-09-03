import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { computeFieldFillRates } from "@/lib/hiring-pack/field-fill-rate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// How many people each field would print for. See `field-fill-rate.ts` for why the count exists.
//
// ONE `field=` PARAMETER PER FIELD, EACH CARRYING THAT FIELD'S WHOLE KEY SET, comma-separated:
//
//   ?field=jobTitleAr&field=employeeName,jobTitleAr
//
// A flat list of distinct keys would be smaller and would give the wrong answer. A field blanks if
// ANY of its placeholders is unresolved, so its count is an INTERSECTION over its keys — and an
// intersection cannot be reconstructed from per-key totals. The `field=` string is echoed back as
// the row's `id` so the client can match answers to rows without holding an index.
//
// GATED ON `employee_documents` READ, the same resource as the rest of `/api/hiring-pack/**`. The
// only thing this discloses is how many of the roster have a value in a given column — an aggregate,
// no names — and whoever is looking at it can already open the same records one at a time.

/** More than the ten fields any one document places, and small enough that nobody can walk the roster with it. */
const MAX_FIELDS = 200;

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "employee_documents", "read");

    const url = new URL(request.url);
    const raw = url.searchParams.getAll("field");
    if (raw.length === 0) {
      return NextResponse.json(
        {
          error: "invalid_request",
          message: "Pass one field= per field, each a comma-separated key set.",
        },
        { status: 400 },
      );
    }
    if (raw.length > MAX_FIELDS) {
      return NextResponse.json(
        { error: "invalid_request", message: `At most ${MAX_FIELDS} fields per request.` },
        { status: 400 },
      );
    }

    const keySets = raw.map((entry) =>
      entry
        .split(",")
        .map((key) => key.trim())
        .filter((key) => key !== ""),
    );

    const report = await computeFieldFillRates(keySets);
    return NextResponse.json(report);
  } catch (error) {
    const status = isForbiddenError(error) ? 403 : 500;
    const message = isForbiddenError(error)
      ? "Not permitted."
      : error instanceof Error
        ? error.message
        : "Something went wrong.";
    return NextResponse.json({ error: "hiring_pack_fill_rate_failed", message }, { status });
  }
}
