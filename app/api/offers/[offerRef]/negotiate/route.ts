import { NextResponse } from "next/server";

import { requestOfferNegotiation } from "@/lib/offers/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Candidate-facing (token, no login): request to negotiate a sent offer.
export async function POST(request: Request, { params }: { params: Promise<{ offerRef: string }> }) {
  try {
    const { offerRef } = await params;
    const result = await requestOfferNegotiation(offerRef, {
      ip: request.headers.get("x-forwarded-for")?.split(",")[0] ?? request.headers.get("x-real-ip"),
      userAgent: request.headers.get("user-agent"),
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error("[offers/negotiate]", error);
    return NextResponse.json({ message: "Offer negotiation request failed. Please try again." }, { status: 500 });
  }
}
