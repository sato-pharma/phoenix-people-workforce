import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { createOfferJobTitle, listOfferJobTitles } from "@/lib/offers/service";
import { offerJsonError } from "@/lib/offers/http";
import { resolveAccessContext } from "@/lib/auth/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "offers", "read");
    return NextResponse.json({ jobTitles: await listOfferJobTitles(), success: true });
  } catch (error) {
    return offerJsonError(error, "Failed to load the job titles.");
  }
}

/**
 * Add a job title and its cost-of-living allowance.
 *
 * The owner's request, verbatim: "make everything editable to add, for example, job title and add
 * its cost of living." Cost of living is flat per title and is the one figure that, with the typed
 * total, produces the whole compensation table.
 */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "offers", "create");

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const title = String(body.title ?? "").trim();
    if (!title) {
      return NextResponse.json({ message: "A job title is required.", success: false }, { status: 400 });
    }

    const costOfLiving = Number(body.costOfLiving ?? 0);
    if (!Number.isFinite(costOfLiving) || costOfLiving < 0) {
      return NextResponse.json(
        { message: "The cost of living must be zero or more.", success: false },
        { status: 400 },
      );
    }

    const jobTitle = await createOfferJobTitle({
      active: body.active === undefined ? true : body.active !== false,
      contractTerm: typeof body.contractTerm === "string" ? body.contractTerm : null,
      costOfLiving,
      reportsTo: typeof body.reportsTo === "string" ? body.reportsTo : null,
      // Null is a real answer — "no preference, use whichever design is the default" — so an
      // absent or blank value normalises to it rather than being refused.
      templateId: typeof body.templateId === "string" ? body.templateId : null,
      title,
    });

    return NextResponse.json({ jobTitle, success: true });
  } catch (error) {
    return offerJsonError(error, "Failed to add this job title.");
  }
}
