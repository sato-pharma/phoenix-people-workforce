import { NextResponse } from "next/server";

import { decideOffer } from "@/lib/offers/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OFFER_REF_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ offerRef: string }> },
) {
  try {
    const { offerRef } = await params;
    if (!OFFER_REF_RE.test(offerRef)) {
      return NextResponse.json({ message: "Invalid offer reference." }, { status: 400 });
    }
    const result = await decideOffer(offerRef, "accepted");
    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Offer acceptance failed.";
    return NextResponse.json({ message }, { status: 500 });
  }
}
