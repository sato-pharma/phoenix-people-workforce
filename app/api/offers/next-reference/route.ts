import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { allocateOfferReference } from "@/lib/offers/service";
import { offerJsonError } from "@/lib/offers/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The reference this title's next offer would get.
 *
 * PROPOSED, not reserved. Nothing is written here and no number is held — the real reference is
 * allocated inside `createOffer`, from the same rules, at the moment the row is inserted. This
 * exists so the composer can show HR the number and put it in the live preview instead of leaving
 * `{{reference}}` standing in braces on screen while they fill the rest of the form.
 *
 * The two can differ if somebody else saves an offer for the same title in between. That is fine,
 * and it is why the number is allocated again at write time rather than trusted from here: the
 * unique index means the stored reference is always the true one.
 *
 * `read` rather than `create`, because this only reports what already exists.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "offers", "read");

    const url = new URL(request.url);
    const title = (url.searchParams.get("title") ?? "").trim();
    if (!title) {
      return NextResponse.json({ message: "A job title is required.", success: false }, { status: 400 });
    }

    const year = Number(url.searchParams.get("year")) || new Date().getUTCFullYear();
    const reference = await allocateOfferReference(title, year);

    return NextResponse.json({ reference, success: true });
  } catch (error) {
    return offerJsonError(error, "Failed to work out the next reference.");
  }
}
