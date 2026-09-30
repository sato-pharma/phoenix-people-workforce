import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import {
  createBusinessCardRequest,
  listBusinessCardRequestsForViewer,
} from "@/lib/business-cards/request-service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CreateBusinessCardRequestBody = {
  cardMobile?: unknown;
  cardName?: unknown;
  note?: unknown;
};

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function errorResponse(error: unknown, fallback = "Business card request failed.") {
  const message = clientSafeErrorMessage(error, fallback);
  const unauthenticated = message.toLowerCase().includes("authentication is required");
  return { message, status: unauthenticated ? 401 : 400 };
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit") ?? "25");
    const items = await listBusinessCardRequestsForViewer(access, Number.isFinite(limit) ? limit : 25);
    return NextResponse.json({ items });
  } catch (error) {
    const { message, status } = errorResponse(error);
    return NextResponse.json({ error: "business_card_requests_load_failed", message }, { status });
  }
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as CreateBusinessCardRequestBody;

    const { notification, row } = await createBusinessCardRequest(access, {
      cardMobile: stringField(body.cardMobile),
      cardName: stringField(body.cardName),
      note: stringField(body.note) || null,
    });

    return NextResponse.json({ item: row, notification }, { status: 201 });
  } catch (error) {
    const { message, status } = errorResponse(error);
    return NextResponse.json({ error: "business_card_request_create_failed", message }, { status });
  }
}
