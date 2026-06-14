import { NextResponse } from "next/server";

import { decideOffer } from "@/lib/offers/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ offerRef: string }> },
) {
  try {
    const { offerRef } = await params;
    const result = await decideOffer(offerRef, "accepted", {
      ip: request.headers.get("x-forwarded-for")?.split(",")[0] ?? request.headers.get("x-real-ip"),
      userAgent: request.headers.get("user-agent"),
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error("[offers/accept]", error);
    return NextResponse.json({ message: "Offer acceptance failed. Please try again." }, { status: 500 });
  }
}
