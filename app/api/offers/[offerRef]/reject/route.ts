import { NextResponse } from "next/server";

import { decideOffer } from "@/lib/offers/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ offerRef: string }> },
) {
  try {
    const { offerRef } = await params;
    const result = await decideOffer(offerRef, "rejected");
    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Offer rejection failed.";
    return NextResponse.json({ message }, { status: 500 });
  }
}
