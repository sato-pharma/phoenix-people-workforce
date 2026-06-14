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
    const result = await decideOffer(offerRef, "rejected", {
      ip: request.headers.get("x-forwarded-for")?.split(",")[0] ?? request.headers.get("x-real-ip"),
      userAgent: request.headers.get("user-agent"),
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error("[offers/reject]", error);
    return NextResponse.json({ message: "Offer rejection failed. Please try again." }, { status: 500 });
  }
}
