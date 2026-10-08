import { NextResponse } from "next/server";

import { isForbiddenError } from "@/lib/auth/server";
import { toApiError, validationError } from "@/lib/http/api-errors";

export { tidyDisputeText } from "./text.ts";
import { checkDisputeImage, DISPUTE_ATTACHMENT_MAX_FILES, type CheckedDisputeImage } from "./attachment-rules.ts";

/**
 * A message from either side: JSON (text only) or multipart/form-data when it carries pictures. Every
 * picture is checked by its OWN bytes here, before anything is written, so a bad file is refused
 * cleanly and never leaves half a message behind.
 */
export async function readDisputeMessageRequest(request: Request): Promise<{
  body: string;
  images: CheckedDisputeImage[];
  fields: Record<string, string>;
}> {
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.startsWith("multipart/form-data")) {
    const form = await request.formData();
    const fields: Record<string, string> = {};
    for (const [key, value] of form.entries()) {
      if (typeof value === "string") fields[key] = value;
    }
    const files = form.getAll("images").filter((entry): entry is File => typeof entry !== "string" && entry.size > 0);
    if (files.length > DISPUTE_ATTACHMENT_MAX_FILES) {
      throw validationError(`A message can carry at most ${DISPUTE_ATTACHMENT_MAX_FILES} pictures.`);
    }
    const images: CheckedDisputeImage[] = [];
    for (const file of files) {
      try {
        images.push(checkDisputeImage({ bytes: new Uint8Array(await file.arrayBuffer()), name: file.name }));
      } catch (error) {
        throw validationError(String(error instanceof Error ? error.message : error).replace(/^Validation:\s*/, ""));
      }
    }
    return { body: String(fields.body ?? ""), fields, images };
  }
  const json = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(json)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") fields[key] = String(value);
  }
  return { body: String(json.body ?? ""), fields, images: [] };
}

/** The one error shape every Dispute Center route answers with. */
export function disputeCenterError(error: unknown, fallback: string) {
  if (isForbiddenError(error)) {
    return NextResponse.json({ error: "forbidden", message: (error as Error).message || "Forbidden.", success: false }, { status: 403 });
  }
  const message = String((error as { message?: unknown } | null)?.message ?? "");
  // The Deductions module signals with a message prefix rather than an ApiError class.
  if (/^Forbidden:/i.test(message)) return NextResponse.json({ error: "forbidden", message, success: false }, { status: 403 });
  if (/^Conflict:/i.test(message)) {
    return NextResponse.json({ error: "conflict", message: message.replace(/^Conflict:\s*/i, ""), success: false }, { status: 409 });
  }
  if (/^Validation:/i.test(message)) {
    return NextResponse.json({ error: "invalid_request", message: message.replace(/^Validation:\s*/i, ""), success: false }, { status: 400 });
  }
  const apiError = toApiError(error, fallback);
  return NextResponse.json({ error: apiError.code, message: apiError.message, success: false }, { status: apiError.status });
}

