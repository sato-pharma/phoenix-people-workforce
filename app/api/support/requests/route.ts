import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import {
  createSupportRequest,
  listSupportRequestsForViewer,
  type SupportRequestAttachment,
} from "@/lib/support-requests/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CreateSupportRequestBody = {
  attachments?: unknown;
  category?: unknown;
  description?: unknown;
  employeeName?: unknown;
  subcategory?: unknown;
  subject?: unknown;
};

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normaliseAttachments(value: unknown): SupportRequestAttachment[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === "object",
    )
    .map((item) => ({
      name: stringField(item.name),
      size: Number(item.size ?? 0) || 0,
      type: stringField(item.type),
    }))
    .filter((item) => item.name.length > 0)
    .slice(0, 10);
}

function errorResponse(error: unknown, fallback = "Support request failed.") {
  const message = error instanceof Error ? error.message : fallback;
  const unauthenticated = message
    .toLowerCase()
    .includes("authentication is required");
  return {
    message,
    status: unauthenticated ? 401 : 400,
  };
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit") ?? "25");
    const items = await listSupportRequestsForViewer(access, limit);
    return NextResponse.json({ items });
  } catch (error) {
    const { message, status } = errorResponse(error);
    return NextResponse.json(
      { error: "support_requests_load_failed", message },
      { status },
    );
  }
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const body = (await request
      .json()
      .catch(() => ({}))) as CreateSupportRequestBody;

    const created = await createSupportRequest(access, {
      attachments: normaliseAttachments(body.attachments),
      category: stringField(body.category),
      description: stringField(body.description),
      employeeName: stringField(body.employeeName),
      hrId: access.hrId ?? "",
      subcategory: stringField(body.subcategory) || null,
      subject: stringField(body.subject),
    });

    return NextResponse.json({ item: created }, { status: 201 });
  } catch (error) {
    const { message, status } = errorResponse(error);
    return NextResponse.json(
      { error: "support_request_create_failed", message },
      { status },
    );
  }
}
