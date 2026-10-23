import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  COMPANY_DETAIL_FIELDS,
  isCompanyDetailKey,
  type CompanyDetailKey,
} from "@/lib/hiring-pack/company-details";
import {
  CompanyDetailsLayerMissingError,
  listCompanyDetailOverrides,
  loadCompanyDetails,
  saveCompanyDetail,
} from "@/lib/hiring-pack/company-details-store";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The company's own details, as every HR Forms document prints them.
//
// NOT UNDER `/<hrId>/`, DELIBERATELY. The three sibling routes write one person's record; this one
// writes the employer's. Hanging it off an employee's path would say the opposite — that the head
// office could differ between two people's papers — and the first reader to believe that would build
// something on it.
//
// READ IS GATED ON `employee_documents`, the same resource as the rest of `/api/hiring-pack/**`:
// whoever can print the documents can see the values printed on them, which they can also simply
// read off the paper.
//
// WRITE IS SUPER ADMIN, and narrower than the read on purpose rather than out of caution. Correcting
// an employee's national ID fixes one file. Changing the company's registered address changes what
// every future contract and every government form states about the employer — the same class of act
// as uploading a company template, which is Super Admin for the same stated reason.

function apiError(error: unknown) {
  if (isForbiddenError(error)) return { message: "Not permitted.", status: 403 };
  if (error instanceof CompanyDetailsLayerMissingError) {
    return { message: error.message, status: 409 };
  }
  return { message: clientSafeErrorMessage(error, "Something went wrong."), status: 500 };
}

/**
 * The company as it will print, plus the catalogue of what may be changed.
 *
 * `fields` is sent so a screen can list every editable value with its own label and its compiled
 * default, without shipping a second copy of that catalogue to the browser and letting the two
 * spellings drift.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "employee_documents", "read");

    const [company, overrides] = await Promise.all([
      loadCompanyDetails(),
      listCompanyDetailOverrides(),
    ]);

    return NextResponse.json({
      canManage: access.role === "Super Admin",
      company,
      overrides,
      fields: Object.entries(COMPANY_DETAIL_FIELDS).map(([key, field]) => ({
        key,
        labelEn: field.labelEn,
        alsoOn: field.alsoOn,
        compiledDefault: field.fallback,
      })),
    });
  } catch (error) {
    const { message, status } = apiError(error);
    return NextResponse.json({ error: "hiring_pack_company_details_read_failed", message }, { status });
  }
}

/**
 * Store one company value, or reset it to the compiled default.
 *
 * ONE VALUE PER REQUEST, matching the store's one-row-per-value shape. A whole-record body would
 * mean two operators editing two different values each writing back their stale copy of the other's,
 * with the second save silently undoing the first — and there is no reason to accept that risk here,
 * because nothing about this record has to be written atomically: the head office and the tax card
 * number are independent facts.
 *
 * `value: null` DELETES the override and returns the paper to the compiled default. An empty STRING
 * is a different instruction — print a blank on purpose — and both are accepted.
 */
export async function PUT(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "employee_documents", "update");
    if (access.role !== "Super Admin") {
      return NextResponse.json(
        {
          error: "forbidden",
          message:
            "Only a Super Admin can change the company's own details — this value prints on every employee's documents.",
        },
        { status: 403 },
      );
    }

    const payload = (await request.json()) as { key?: unknown; value?: unknown };
    if (!isCompanyDetailKey(payload.key)) {
      return NextResponse.json(
        {
          error: "invalid_request",
          message: `“${String(payload.key ?? "")}” is not a company value this system stores.`,
        },
        { status: 400 },
      );
    }
    const key: CompanyDetailKey = payload.key;

    if (payload.value !== null && typeof payload.value !== "string") {
      return NextResponse.json(
        {
          error: "invalid_request",
          message: "A company value is text, or null to reset it to the system default.",
        },
        { status: 400 },
      );
    }

    const company = await saveCompanyDetail(key, payload.value, access.hrId ?? null);
    return NextResponse.json({ company });
  } catch (error) {
    const { message, status } = apiError(error);
    return NextResponse.json({ error: "hiring_pack_company_details_save_failed", message }, { status });
  }
}
