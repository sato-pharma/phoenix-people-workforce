import { NextResponse } from "next/server";

import { isForbiddenError } from "@/lib/auth/server";
import { toApiError, validationError } from "@/lib/http/api-errors";

export { tidyDisputeText } from "./text.ts";
import { checkDisputeImage, DISPUTE_ATTACHMENT_MAX_FILES, type CheckedDisputeImage } from "./attachment-rules.ts";

/**
 * The pictures of a Dispute Center reply, each checked by its own bytes before anything is written (owner,
 * 2026-10-09: "upload a picture in both"). The route reads the reply through its schema (REC-060) and hands the
 * form's files here; empty file inputs are dropped.
 */
export async function checkDisputeMessageImages(files: readonly File[]): Promise<CheckedDisputeImage[]> {
  const real = files.filter((file) => file.size > 0);
  if (real.length > DISPUTE_ATTACHMENT_MAX_FILES) {
    throw validationError(`A message can carry at most ${DISPUTE_ATTACHMENT_MAX_FILES} pictures.`);
  }
  const images: CheckedDisputeImage[] = [];
  for (const file of real) {
    try {
      images.push(checkDisputeImage({ bytes: new Uint8Array(await file.arrayBuffer()), name: file.name }));
    } catch (error) {
      throw validationError(String(error instanceof Error ? error.message : error).replace(/^Validation:\s*/, ""));
    }
  }
  return images;
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

